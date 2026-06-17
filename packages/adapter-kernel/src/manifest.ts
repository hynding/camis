import { createHash } from "node:crypto";
import type { GeneratedFile, Manifest, ManifestEntry } from "./types";

export const MANIFEST_PATH = ".camis/manifest.json";

export const sha256 = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

export const buildManifest = (files: GeneratedFile[]): Manifest => ({
  generator: "camis",
  files: files
    .filter((f) => f.path !== MANIFEST_PATH)
    .map(
      (f): ManifestEntry => ({
        path: f.path,
        mode: f.mode ?? "overwrite",
        sha256: sha256(f.content),
      }),
    )
    .sort((a, b) => a.path.localeCompare(b.path)),
});
