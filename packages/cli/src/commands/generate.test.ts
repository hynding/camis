import { describe, expect, it, vi } from "vitest";
import type { GenerationResult } from "@camis/adapter-kernel";
import type { MockedFunction } from "vitest";
import { generateCommand, printGaps } from "./generate";
import type { Io } from "../io";

const config = JSON.stringify({
  ir: "./camis.json",
  targets: [{ target: "express", out: "./out/api" }],
});
const ir = JSON.stringify({
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "string", name: "title", required: true },
        { type: "component", name: "seo", component: "Seo", repeatable: false },
      ],
    },
  ],
  components: [{ name: "Seo", fields: [{ type: "string", name: "metaTitle" }] }],
});

const io = (lines: string[], materializeSpy = vi.fn(() => Promise.resolve())): Io => ({
  readFile: (p) => Promise.resolve(p.endsWith("camis.config.json") ? config : ir),
  writeFile: () => Promise.resolve(),
  materialize: materializeSpy,
  out: (l) => lines.push(l),
  cwd: "/p",
});

describe("generateCommand", () => {
  it("dry-run prints a file count + gap and writes nothing", async () => {
    const lines: string[] = [];
    const spy = vi.fn(() => Promise.resolve());
    const code = await generateCommand("camis.config.json", io(lines, spy), { write: false });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/express: \d+ files/);
    expect(lines.join("\n")).toContain("⚠");
    expect(spy).not.toHaveBeenCalled();
  });
  it("build materializes each target", async () => {
    const lines: string[] = [];
    const spy = vi.fn(() => Promise.resolve()) as MockedFunction<
      (r: GenerationResult, d: string) => Promise<void>
    >;
    const code = await generateCommand("camis.config.json", io(lines, spy), { write: true });
    expect(code).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe("/p/out/api");
  });
});

describe("printGaps", () => {
  it("returns true when any gap is severity error, false for downgrades only", () => {
    const lines: string[] = [];
    const io: Io = {
      readFile: () => Promise.resolve(""),
      writeFile: () => Promise.resolve(),
      materialize: () => Promise.resolve(),
      out: (l) => lines.push(l),
      cwd: "/p",
    };
    expect(
      printGaps(io, [{ feature: "x", location: {}, severity: "downgrade", message: "m" }]),
    ).toBe(false);
    expect(
      printGaps(io, [
        { feature: "y", location: { contentType: "A" }, severity: "error", message: "boom" },
      ]),
    ).toBe(true);
    expect(lines.join("\n")).toContain("boom");
  });
});
