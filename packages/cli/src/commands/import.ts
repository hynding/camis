import { isAbsolute, join, resolve } from "node:path";
import { stableJson } from "@camis/adapter-kernel";
import { importExpressProject } from "@camis/adapter-express";
import { readStrapiProject } from "@camis/adapter-strapi";
import { validate } from "@camis/ir-core";
import type { CapabilityGap, IrDocument, Result } from "@camis/ir-schema";
import type { Io } from "../io";
import { printGaps } from "./generate";
import { locStr } from "./validate";

const abs = (io: Io, p: string): string => (isAbsolute(p) ? p : resolve(io.cwd, p));

export const importCommand = async (
  target: string,
  projectDir: string,
  outPath: string,
  io: Io,
  opts: { upsertBy?: string } = {},
): Promise<number> => {
  const dir = abs(io, projectDir);
  let imported: Result<IrDocument>;
  let gaps: CapabilityGap[] = [];
  if (target === "strapi") {
    const read = await readStrapiProject(dir, opts);
    imported = read.document;
    gaps = read.gaps.gaps;
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
  const revalidated = validate(imported.value);
  if (!revalidated.ok) {
    for (const e of revalidated.errors)
      io.out(`✗ [${e.code}] ${locStr(e.location)} — ${e.message}`);
    return 1;
  }
  const out = abs(io, outPath);
  await io.writeFile(out, stableJson(revalidated.value));
  io.out(`✓ imported → ${outPath}`);
  printGaps(io, gaps);
  return 0;
};
