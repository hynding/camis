import { basename, isAbsolute, join, resolve } from "node:path";
import { stableJson } from "@camis/adapter-kernel";
import { readStrapiProject } from "@camis/adapter-strapi";
import { validate } from "@camis/ir-core";
import type { IrDocument } from "@camis/ir-schema";
import type { Io } from "../io";
import type { TargetConfig } from "../config";
import {
  PROJECT_TEMPLATES,
  isProjectTemplateName,
  projectTemplate,
  strapiDefaultRoles,
  withMediaLibrary,
  withSuperAdmin,
  type ProjectTemplate,
} from "../templates";
import { generateCommand, printGaps } from "./generate";
import { scaffoldCommand } from "./scaffold";
import { strapiRoles, type StrapiRolesSource } from "./strapi-roles";
import { locStr } from "./validate";

type TargetName = TargetConfig["target"];
type Dialect = NonNullable<TargetConfig["dialect"]>;

const TARGETS: readonly TargetName[] = ["strapi", "filament", "express"];
const DIALECTS: readonly Dialect[] = ["sqlite", "mysql", "pgsql"];

export interface NewOptions {
  template?: string;
  targets?: string[];
  dialect?: string;
  fromStrapi?: string;
  /** With `fromStrapi`: a Strapi export whose roles become the project's. */
  strapiRoles?: StrapiRolesSource;
  skipScaffold?: boolean;
  skipBuild?: boolean;
}

interface Plan {
  targets: TargetName[];
  dialect?: Dialect;
}

const planFrom = (options: NewOptions): { ok: true; plan: Plan } | { ok: false; error: string } => {
  if (options.fromStrapi !== undefined && options.template !== undefined) {
    return { ok: false, error: "--from-strapi and --template cannot be combined" };
  }
  if (options.strapiRoles !== undefined && options.fromStrapi === undefined) {
    return { ok: false, error: "--roles-from reads a Strapi export, so it needs --from-strapi" };
  }
  if (options.template !== undefined && !isProjectTemplateName(options.template)) {
    return {
      ok: false,
      error: `unknown template "${options.template}" (use ${PROJECT_TEMPLATES.join(" or ")})`,
    };
  }
  const targets: TargetName[] = [];
  for (const target of options.targets ?? ["strapi"]) {
    const known = TARGETS.find((t) => t === target);
    if (known === undefined) {
      return { ok: false, error: `unknown target "${target}" (use ${TARGETS.join(", ")})` };
    }
    if (!targets.includes(known)) targets.push(known);
  }
  if (options.dialect === undefined) return { ok: true, plan: { targets } };
  const dialect = DIALECTS.find((d) => d === options.dialect);
  if (dialect === undefined) {
    return {
      ok: false,
      error: `unknown dialect "${options.dialect}" (use ${DIALECTS.join(", ")})`,
    };
  }
  if (!targets.includes("express")) {
    return { ok: false, error: "--dialect applies only to the express target" };
  }
  return { ok: true, plan: { targets, dialect } };
};

const targetConfig = (target: TargetName, projectName: string, plan: Plan): TargetConfig => {
  const base = { target, out: `./generated/${target}`, projectName };
  // A filament target answers on Strapi's wire format, so a Strapi client can switch to it.
  if (target === "filament") return { ...base, apiStyle: "strapi" };
  if (target === "express" && plan.dialect !== undefined) return { ...base, dialect: plan.dialect };
  return base;
};

const exists = async (io: Io, path: string): Promise<boolean> =>
  io.readFile(path).then(
    () => true,
    () => false,
  );

const importFromStrapi = async (
  io: Io,
  sourceDir: string,
): Promise<{ ok: true; document: IrDocument } | { ok: false }> => {
  const read = await readStrapiProject(
    isAbsolute(sourceDir) ? sourceDir : resolve(io.cwd, sourceDir),
  );
  if (!read.document.ok) {
    for (const e of read.document.errors)
      io.out(`✗ [${e.code}] ${locStr(e.location)} — ${e.message}`);
    return { ok: false };
  }
  const document = read.document.value;
  if (document.contentTypes.length === 0 && document.components.length === 0) {
    io.out(`✗ ${sourceDir} has no Strapi content types or components under src/`);
    return { ok: false };
  }
  io.out(`✓ imported ${document.contentTypes.length} content types from ${sourceDir}`);
  printGaps(io, read.gaps.gaps);
  return { ok: true, document };
};

const readme = (name: string, targets: TargetName[]): string => `# ${name}

A [camis](https://github.com/hynding/camis) project: one content model, generated into
${targets.join(", ")}.

- \`camis.json\` is the content model (the IR). Edit it, then run \`camis build\`.
- \`roles.json\` holds the roles and their grants: \`public\` and \`authenticated\`, as in Strapi, and
  \`super-admin\`, the role that may sign in to the admin (\`php artisan camis:admin <email>\` makes one).
- \`camis.config.json\` names the targets and where each one is generated.
- \`protected/\` is copied into every target after generation; hand-written code lives there.
- \`generated/\` is rebuilt by \`camis build\` and is not committed.

\`\`\`sh
camis validate camis.json   # check the content model
camis generate              # list what each target would write
camis build                 # write every target into generated/
\`\`\`
`;

const GITIGNORE = "generated/\nnode_modules/\n.env\n";

const writeProject = async (
  io: Io,
  projectDir: string,
  content: ProjectTemplate,
  targets: TargetConfig[],
): Promise<void> => {
  const name = basename(projectDir);
  await io.writeFile(join(projectDir, "camis.json"), stableJson(content.document));
  await io.writeFile(join(projectDir, "roles.json"), stableJson(content.roles));
  await io.writeFile(
    join(projectDir, "camis.config.json"),
    stableJson({ ir: "./camis.json", roles: "./roles.json", protected: "./protected", targets }),
  );
  await io.writeFile(join(projectDir, "protected/.gitkeep"), "");
  await io.writeFile(join(projectDir, ".gitignore"), GITIGNORE);
  await io.writeFile(
    join(projectDir, "README.md"),
    readme(
      name,
      targets.map((t) => t.target),
    ),
  );
};

export const newCommand = async (dir: string, io: Io, options: NewOptions): Promise<number> => {
  const planned = planFrom(options);
  if (!planned.ok) {
    io.out(`✗ ${planned.error}`);
    return 1;
  }
  const { plan } = planned;
  const projectDir = isAbsolute(dir) ? dir : resolve(io.cwd, dir);
  const name = basename(projectDir);
  for (const file of ["camis.config.json", "camis.json"]) {
    if (await exists(io, join(projectDir, file))) {
      io.out(`✗ ${dir} already contains a camis project (${file}); refusing to overwrite it`);
      return 1;
    }
  }

  let content: ProjectTemplate;
  if (options.fromStrapi !== undefined) {
    const imported = await importFromStrapi(io, options.fromStrapi);
    if (!imported.ok) return 1;
    if (options.strapiRoles === undefined) {
      content = { document: imported.document, roles: strapiDefaultRoles() };
    } else {
      const roles = await strapiRoles(io, imported.document, options.strapiRoles);
      if (!roles.ok) return 1;
      content = { document: roles.document, roles: roles.roles };
    }
  } else {
    content = projectTemplate(
      options.template !== undefined && isProjectTemplateName(options.template)
        ? options.template
        : "vanilla",
    );
  }
  const validated = validate(withMediaLibrary(content.document));
  if (!validated.ok) {
    for (const e of validated.errors) io.out(`✗ [${e.code}] ${locStr(e.location)} — ${e.message}`);
    return 1;
  }

  const targets = plan.targets.map((t) => targetConfig(t, name, plan));
  await writeProject(
    io,
    projectDir,
    { document: validated.value, roles: withSuperAdmin(content.roles, validated.value) },
    targets,
  );
  io.out(`✓ wrote camis.json, roles.json and camis.config.json in ${dir}`);

  const pending: string[] = [];
  if (plan.targets.includes("filament")) {
    if (options.skipScaffold === true) {
      pending.push("camis scaffold filament generated/filament");
    } else if (
      (await scaffoldCommand("filament", join(projectDir, "generated/filament"), io)) !== 0
    ) {
      return 1;
    }
  }
  if (options.skipBuild === true) {
    pending.push("camis build");
  } else if (
    (await generateCommand(join(projectDir, "camis.config.json"), io, { write: true })) !== 0
  ) {
    return 1;
  }

  io.out(`✓ created camis project ${name}`);
  io.out(`  next: cd ${dir}${pending.map((step) => ` && ${step}`).join("")}`);
  if (plan.targets.includes("filament")) {
    io.out(
      "  then, in generated/filament: php artisan migrate && php artisan db:seed --class=RolePermissionSeeder && php artisan camis:admin <email>",
    );
  }
  return 0;
};
