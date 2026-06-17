import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest } from "./manifest";
import { materialize } from "./materialize";
import type { GenerationResult } from "./types";

const result = (files: GenerationResult["files"]): GenerationResult => ({
  files,
  manifest: buildManifest(files),
  gaps: { target: "t", gaps: [] },
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "camis-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("materialize", () => {
  it("writes overwrite files and the manifest", async () => {
    await materialize(result([{ path: "src/a.ts", content: "A" }]), dir);
    expect(await readFile(join(dir, "src/a.ts"), "utf8")).toBe("A");
    expect(existsSync(join(dir, ".camis/manifest.json"))).toBe(true);
  });

  it("leaves a protected (unmanaged) file untouched across regen", async () => {
    await materialize(result([{ path: "src/a.ts", content: "A" }]), dir);
    await writeFile(join(dir, "hand.ts"), "MINE");
    await materialize(result([{ path: "src/a.ts", content: "A2" }]), dir);
    expect(await readFile(join(dir, "hand.ts"), "utf8")).toBe("MINE");
    expect(await readFile(join(dir, "src/a.ts"), "utf8")).toBe("A2");
  });

  it("deletes an overwrite file dropped from the new manifest", async () => {
    await materialize(
      result([
        { path: "a.ts", content: "A" },
        { path: "b.ts", content: "B" },
      ]),
      dir,
    );
    await materialize(result([{ path: "a.ts", content: "A" }]), dir);
    expect(existsSync(join(dir, "b.ts"))).toBe(false);
    expect(existsSync(join(dir, "a.ts"))).toBe(true);
  });
});
