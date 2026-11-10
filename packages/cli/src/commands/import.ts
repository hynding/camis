import { dirname, isAbsolute, join, resolve } from "node:path";
import { stableJson } from "@camis/adapter-kernel";
import { importExpressProject } from "@camis/adapter-express";
import { deploymentEnv } from "@camis/adapter-filament";
import { deploymentSettings, readStrapiProject } from "@camis/adapter-strapi";
import { validate } from "@camis/ir-core";
import type { CapabilityGap, IrDocument, Result } from "@camis/ir-schema";
import type { Role, RolesFile } from "@camis/permissions";
import type { Io } from "../io";
import { strapiDefaultRoles, withMediaLibrary, withStrapiUsers } from "../templates";
import { printGaps } from "./generate";
import { readStrapiConfig } from "./strapi-config";
import {
  strapiAdminRoles,
  strapiRoles,
  withAdminRoles,
  type StrapiRolesSource,
} from "./strapi-roles";
import { locStr } from "./validate";

const abs = (io: Io, p: string): string => (isAbsolute(p) ? p : resolve(io.cwd, p));

export const importCommand = async (
  target: string,
  projectDir: string,
  outPath: string,
  io: Io,
  opts: {
    upsertBy?: string;
    /** A Strapi export whose roles become the IR's, and where to write them. */
    roles?: StrapiRolesSource & { out: string };
    /** A Strapi project's SQLite database, whose admin roles join the roles file. */
    adminRoles?: string;
    /** Where the roles file goes when only admin roles are read (default roles.json). */
    rolesOut?: string;
    /** Where the Laravel env a Strapi project's config maps to goes (default: beside the IR). */
    envOut?: string;
  } = {},
): Promise<number> => {
  const dir = abs(io, projectDir);
  let imported: Result<IrDocument>;
  let gaps: CapabilityGap[] = [];
  if (target === "strapi") {
    const read = await readStrapiProject(
      dir,
      opts.upsertBy !== undefined ? { upsertBy: opts.upsertBy } : {},
    );
    imported = read.document;
    gaps = read.gaps.gaps;
  } else if (opts.roles !== undefined) {
    io.out("✗ --roles-from reads a Strapi export, so it applies only to `import strapi`");
    return 1;
  } else if (opts.adminRoles !== undefined) {
    io.out("✗ --admin-roles-from reads a Strapi database, so it applies only to `import strapi`");
    return 1;
  } else if (target === "express") {
    let content: string;
    try {
      content = await io.readFile(join(dir, "camis.schema.json"));
    } catch (e) {
      io.out(`✗ cannot read ${join(projectDir, "camis.schema.json")}: ${(e as Error).message}`);
      return 1;
    }
    imported = importExpressProject([{ path: "camis.schema.json", content }]).document;
  } else {
    io.out(`✗ "${target}" has no importer; generation is one-way (import from strapi or express)`);
    return 1;
  }

  if (!imported.ok) {
    for (const e of imported.errors) io.out(`✗ [${e.code}] ${locStr(e.location)} — ${e.message}`);
    return 1;
  }
  // Strapi's upload plugin is always there, so its media library comes with the project.
  const revalidated = validate(
    target === "strapi" ? withMediaLibrary(imported.value) : imported.value,
  );
  if (!revalidated.ok) {
    for (const e of revalidated.errors)
      io.out(`✗ [${e.code}] ${locStr(e.location)} — ${e.message}`);
    return 1;
  }
  let document = revalidated.value;
  let roles: RolesFile | undefined;
  if (opts.roles !== undefined) {
    const read = await strapiRoles(io, document, opts.roles);
    if (!read.ok) return 1;
    document = read.document;
    roles = read.roles;
  }
  let adminRoles: Role[] | undefined;
  if (opts.adminRoles !== undefined) {
    const taken = (roles ?? strapiDefaultRoles()).roles.map((r) => r.name);
    const read = strapiAdminRoles(io, document, opts.adminRoles, taken);
    if (!read.ok) return 1;
    document = read.document;
    adminRoles = read.roles;
  }
  // As its upload plugin, Strapi's users-permissions plugin is always there.
  if (target === "strapi") document = withStrapiUsers(document);
  if (adminRoles !== undefined) {
    const merged = withAdminRoles(io, roles ?? strapiDefaultRoles(), adminRoles, document);
    if (!merged.ok) return 1;
    roles = merged.roles;
  }
  if (roles !== undefined) {
    const rolesOut = opts.roles?.out ?? opts.rolesOut ?? "roles.json";
    await io.writeFile(abs(io, rolesOut), stableJson(roles));
    io.out(`✓ roles → ${rolesOut}`);
  }
  const out = abs(io, outPath);
  await io.writeFile(out, stableJson(document));
  io.out(`✓ imported → ${outPath}`);
  if (target === "strapi") {
    const envOut = opts.envOut ?? join(dirname(outPath), "deployment.env");
    gaps = [...gaps, ...(await writeDeploymentEnv(io, dir, abs(io, envOut), envOut))];
  }
  printGaps(io, gaps);
  return 0;
};

/**
 * The Laravel .env lines for how a Strapi project is run (config/plugins, config/api and
 * config/middlewares: its upload and email providers, API page sizes, sessions and CORS), written for the Filament app; the
 * gaps are the options that have no counterpart there.
 */
const writeDeploymentEnv = async (
  io: Io,
  dir: string,
  path: string,
  shown: string,
): Promise<CapabilityGap[]> => {
  const capture = io.capture?.bind(io);
  const configs = [];
  for (const name of ["plugins", "api", "middlewares"]) {
    const read = await readStrapiConfig(dir, name, capture);
    if (!read.ok) {
      io.out(`  ⚠ ${read.message}; ${shown} not written`);
      return [];
    }
    configs.push(read.config);
  }
  const [pluginsConfig, apiConfig, middlewaresConfig] = configs;
  if (configs.every((config) => config === undefined)) return [];
  const { settings, gaps } = deploymentSettings(pluginsConfig ?? {}, apiConfig, middlewaresConfig);
  const { env, packages } = deploymentEnv(settings);
  if (env !== "") {
    await io.writeFile(path, env);
    io.out(`✓ deployment settings → ${shown}`);
    if (packages.length > 0)
      io.out(`  the Laravel app needs: composer require ${packages.join(" ")}`);
  }
  return gaps;
};
