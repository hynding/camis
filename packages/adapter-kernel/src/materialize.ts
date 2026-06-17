import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MANIFEST_PATH } from "./manifest";
import { stableJson } from "./stable-json";
import type { GenerationResult, Manifest } from "./types";

export const materialize = async (result: GenerationResult, destDir: string): Promise<void> => {
  const manifestAbs = join(destDir, MANIFEST_PATH);
  let prior: Manifest | undefined;
  if (existsSync(manifestAbs)) {
    prior = JSON.parse(await readFile(manifestAbs, "utf8")) as Manifest;
  }

  const newPaths = new Set(result.files.map((f) => f.path));
  if (prior) {
    for (const entry of prior.files) {
      if (entry.mode === "overwrite" && !newPaths.has(entry.path)) {
        await rm(join(destDir, entry.path), { force: true });
      }
    }
  }

  for (const file of result.files) {
    const abs = join(destDir, file.path);
    if ((file.mode ?? "overwrite") === "seed" && existsSync(abs)) continue;
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content, "utf8");
  }

  await mkdir(dirname(manifestAbs), { recursive: true });
  await writeFile(manifestAbs, stableJson(result.manifest), "utf8");
};
