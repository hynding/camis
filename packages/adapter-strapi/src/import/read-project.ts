import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityGapReport, IrDocument, Result } from "@camis/ir-schema";
import { customCodeGaps, type ProjectFile } from "./custom-code";
import type { ImportOptions } from "./import-document";
import { importDocument } from "./import-document";

const SCHEMAS = ["src/api/*/content-types/*/schema.json", "src/components/*/*.json"];
const CODE = [
  "src/**/*.{js,cjs,mjs,jsx,ts,tsx}",
  "config/*.{js,cjs,mjs,ts}",
  "src/plugins/*/package.json",
];

const inDependencies = (path: string): boolean => path.split(/[\\/]/).includes("node_modules");

const read = async (dir: string, patterns: string[]): Promise<ProjectFile[]> => {
  const files: ProjectFile[] = [];
  for (const pattern of patterns) {
    for await (const entry of glob(pattern, { cwd: dir, exclude: inDependencies })) {
      files.push({
        path: entry.split("\\").join("/"),
        content: await readFile(join(dir, entry), "utf8"),
      });
    }
  }
  return files;
};

export const readStrapiProject = async (
  dir: string,
  opts: ImportOptions = {},
): Promise<{ document: Result<IrDocument>; gaps: CapabilityGapReport }> => {
  const imported = importDocument(await read(dir, SCHEMAS), opts);
  const code = customCodeGaps(await read(dir, CODE));
  return { ...imported, gaps: { ...imported.gaps, gaps: [...imported.gaps.gaps, ...code] } };
};
