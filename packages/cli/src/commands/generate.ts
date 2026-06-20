import { basename } from "node:path";
import type { CapabilityGap } from "@camis/ir-schema";
import { validate } from "@camis/ir-core";
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

  let exit = 0;
  for (const t of cfg.value.targets) {
    const projectName = t.projectName ?? basename(t.out);
    const result = adapterFor(t).generate({ document, roles: [] }, { projectName });
    const errorGap = printGaps(io, result.gaps.gaps);
    if (errorGap) {
      io.out(`✗ ${t.target}: aborted — unrepresentable feature (error gap)`);
      exit = 1;
      continue;
    }
    if (opts.write) {
      await io.materialize(result, t.out);
      io.out(`✓ ${t.target}: wrote ${result.files.length} files → ${t.out}`);
    } else {
      io.out(`${t.target}: ${result.files.length} files → ${t.out} (dry-run)`);
    }
  }
  return exit;
};
