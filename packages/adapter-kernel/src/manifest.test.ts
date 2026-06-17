import { describe, expect, it } from "vitest";
import { buildManifest, MANIFEST_PATH, sha256 } from "./manifest";
import type { GeneratedFile } from "./types";

describe("manifest", () => {
  it("hashes content with sha256", () => {
    expect(sha256("x")).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
  });

  it("lists files sorted by path with mode and hash, excluding the manifest itself", () => {
    const files: GeneratedFile[] = [
      { path: "b.txt", content: "b" },
      { path: "a.txt", content: "a", mode: "seed" },
      { path: MANIFEST_PATH, content: "ignored" },
    ];
    const m = buildManifest(files);
    expect(m.generator).toBe("camis");
    expect(m.files.map((f) => f.path)).toEqual(["a.txt", "b.txt"]);
    expect(m.files[0]).toMatchObject({ path: "a.txt", mode: "seed" });
    expect(m.files[1]).toMatchObject({ path: "b.txt", mode: "overwrite" });
  });
});
