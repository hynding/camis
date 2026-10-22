import { basename } from "node:path";
import type { CapabilityGap } from "@camis/ir-schema";
import { validate } from "@camis/ir-core";
import { parseRolesFile, validateBundle, type Role } from "@camis/permissions";
import type { Io } from "../io";
import { loadConfig } from "../config";
import { adapterFor } from "../registry";
import { locStr } from "./validate";

export const printGaps = (io: Io, gaps: CapabilityGap[]): boolean => {
  let hasError = false;
  for (const g of gaps) {
    if (g.severity === "error") hasError = true;
    io.out(`  ⚠ ${g.feature} @ ${locStr(g.location)} — ${g.message}`);
  }
  return hasError;
};

export const generateCommand = async (
  configPath: string,
  io: Io,
  opts: { write: boolean },
): Promise<number> => {
  const cfg = await loadConfig(io, configPath);
  if (!cfg.ok) {
    io.out(`✗ config: ${cfg.error}`);
    return 1;
  }

  let irRaw: unknown;
  try {
    irRaw = JSON.parse(await io.readFile(cfg.value.ir));
  } catch (e) {
    io.out(`✗ cannot read IR ${cfg.value.ir}: ${(e as Error).message}`);
    return 1;
  }
  const validated = validate(irRaw);
  if (!validated.ok) {
    for (const e of validated.errors) io.out(`✗ [${e.code}] ${locStr(e.location)} — ${e.message}`);
    return 1;
  }
  const document = validated.value;

  let roles: Role[] = [];
  let defaultRole: string | undefined;
  if (cfg.value.roles !== undefined) {
    let rolesRaw: unknown;
    try {
      rolesRaw = JSON.parse(await io.readFile(cfg.value.roles));
    } catch (e) {
      io.out(`✗ cannot read roles ${cfg.value.roles}: ${(e as Error).message}`);
      return 1;
    }
    const parsed = parseRolesFile(rolesRaw);
    if (!parsed.ok) {
      io.out(`✗ roles: ${parsed.issues.join("; ")}`);
      return 1;
    }
    const bundle = validateBundle({
      document,
      roles: parsed.value.roles,
      ...(parsed.value.defaultRole !== undefined ? { defaultRole: parsed.value.defaultRole } : {}),
    });
    if (!bundle.ok) {
      for (const e of bundle.errors) io.out(`✗ [${e.code}] ${locStr(e.location)} — ${e.message}`);
      return 1;
    }
    roles = bundle.value.roles;
    defaultRole = bundle.value.defaultRole;
  }

  let exit = 0;
  for (const t of cfg.value.targets) {
    const projectName = t.projectName ?? basename(t.out);
    const result = adapterFor(t).generate(
      { document, roles, ...(defaultRole !== undefined ? { defaultRole } : {}) },
      {
        projectName,
        ...(t.apiStyle !== undefined ? { apiStyle: t.apiStyle } : {}),
        ...(t.storageLayout !== undefined ? { storageLayout: t.storageLayout } : {}),
        ...(t.alwaysPopulateComponents !== undefined
          ? { alwaysPopulateComponents: t.alwaysPopulateComponents }
          : {}),
        ...(t.graphql !== undefined ? { graphql: t.graphql } : {}),
      },
    );
    const errorGap = printGaps(io, result.gaps.gaps);
    if (errorGap) {
      io.out(`✗ ${t.target}: aborted — unrepresentable feature (error gap)`);
      exit = 1;
      continue;
    }
    if (opts.write) {
      await io.materialize(result, t.out);
      if (cfg.value.protected !== undefined) {
        await io.copyDir(cfg.value.protected, t.out);
        io.out(`✓ ${t.target}: mirrored ${cfg.value.protected} → ${t.out}`);
      }
      io.out(`✓ ${t.target}: wrote ${result.files.length} files → ${t.out}`);
    } else {
      io.out(`${t.target}: ${result.files.length} files → ${t.out} (dry-run)`);
    }
  }
  return exit;
};
