import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("bin wrapper", () => {
  it("runs under plain node (tsx registered at runtime)", () => {
    const r = spawnSync(process.execPath, [join(pkgRoot, "bin/camis.mjs"), "help"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });
});
