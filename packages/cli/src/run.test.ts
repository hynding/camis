import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materialize } from "@camis/adapter-kernel";
import type { Io } from "./io";
import { run } from "./run";

const lines: string[] = [];
let tmp = "";
afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
  tmp = "";
  lines.length = 0;
});

// A real-fs Io rooted at a temp dir (for the end-to-end build).
const realIo = (cwd: string): Io => ({
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, c) => writeFile(p, c),
  materialize,
  out: (l) => lines.push(l),
  cwd,
});

describe("run", () => {
  it("prints usage and exits 1 on an unknown command", async () => {
    const io: Io = {
      readFile: () => Promise.resolve(""),
      writeFile: () => Promise.resolve(),
      materialize: () => Promise.resolve(),
      out: (l) => lines.push(l),
      cwd: "/p",
    };
    expect(await run(["wat"], io)).toBe(1);
    expect(lines.join("\n").toLowerCase()).toContain("usage");
  });

  it("EXIT CRITERIA: a single config builds a target end-to-end", async () => {
    tmp = await mkdtemp(join(tmpdir(), "camis-cli-e2e-"));
    await writeFile(
      join(tmp, "camis.json"),
      JSON.stringify({
        version: 1,
        contentTypes: [
          {
            name: "Article",
            kind: "collection",
            fields: [{ type: "string", name: "title", required: true }],
          },
        ],
        components: [],
      }),
    );
    await writeFile(
      join(tmp, "camis.config.json"),
      JSON.stringify({
        ir: "./camis.json",
        targets: [{ target: "express", out: "./generated/api" }],
      }),
    );

    const code = await run(["build", "--config", join(tmp, "camis.config.json")], realIo(tmp));
    expect(code).toBe(0);
    const pkg = JSON.parse(await readFile(join(tmp, "generated/api/package.json"), "utf8"));
    expect(pkg.dependencies["drizzle-orm"]).toBeDefined();
    expect(lines.join("\n")).toContain("wrote");
  });
});
