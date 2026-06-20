import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import type { Io } from "./io";

const fakeIo = (files: Record<string, string>): Io => ({
  readFile: (p) =>
    p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error(`ENOENT ${p}`)),
  writeFile: () => Promise.resolve(),
  materialize: () => Promise.resolve(),
  out: () => {},
  cwd: "/proj",
});

describe("loadConfig", () => {
  it("parses a valid config and resolves ir + out relative to the config dir", async () => {
    const io = fakeIo({
      "/proj/camis.config.json": JSON.stringify({
        ir: "./camis.json",
        targets: [{ target: "express", out: "./generated/api" }],
      }),
    });
    const cfg = await loadConfig(io, "camis.config.json");
    expect(cfg.ok).toBe(true);
    if (cfg.ok) {
      expect(cfg.value.ir).toBe("/proj/camis.json");
      expect(cfg.value.targets[0]!.out).toBe("/proj/generated/api");
      expect(cfg.value.targets[0]!.target).toBe("express");
    }
  });
  it("rejects an unknown target and a missing out", async () => {
    const io = fakeIo({
      "/proj/c.json": JSON.stringify({
        ir: "./x.json",
        targets: [{ target: "django", out: "./o" }],
      }),
    });
    expect((await loadConfig(io, "c.json")).ok).toBe(false);
    const io2 = fakeIo({
      "/proj/c.json": JSON.stringify({ ir: "./x.json", targets: [{ target: "strapi" }] }),
    });
    expect((await loadConfig(io2, "c.json")).ok).toBe(false);
  });
});
