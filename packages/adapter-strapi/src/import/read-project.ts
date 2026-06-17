import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityGapReport, IrDocument, Result } from "@camis/ir-schema";
import { importDocument } from "./import-document";

export const readStrapiProject = async (
  dir: string,
): Promise<{ document: Result<IrDocument>; gaps: CapabilityGapReport }> => {
  const patterns = ["src/api/*/content-types/*/schema.json", "src/components/*/*.json"];
  const files: { path: string; content: string }[] = [];
  for (const pattern of patterns) {
    for await (const entry of glob(pattern, { cwd: dir })) {
      files.push({ path: entry, content: await readFile(join(dir, entry), "utf8") });
    }
  }
  return importDocument(files);
};
