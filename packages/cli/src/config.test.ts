import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import type { Io } from "./io";

const fakeIo = (files: Record<string, string>): Io => ({
  readFile: (p) =>
    p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error(`ENOENT ${p}`)),
  writeFile: () => Promise.resolve(),
  materialize: () => Promise.resolve(),
  exec: () => Promise.resolve(0),
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

describe("loadConfig — roles", () => {
  it("resolves an optional roles path relative to the config dir", async () => {
    const io = fakeIo({
      "/proj/camis.config.json": JSON.stringify({
        ir: "./camis.json",
        roles: "./camis.roles.json",
        targets: [{ target: "filament", out: "./generated/admin" }],
      }),
    });
    const cfg = await loadConfig(io, "camis.config.json");
    expect(cfg.ok).toBe(true);
    if (cfg.ok) expect(cfg.value.roles).toBe("/proj/camis.roles.json");
  });

  it("leaves roles undefined when the key is absent", async () => {
    const io = fakeIo({
      "/proj/camis.config.json": JSON.stringify({
        ir: "./camis.json",
        targets: [{ target: "filament", out: "./generated/admin" }],
      }),
    });
    const cfg = await loadConfig(io, "camis.config.json");
    expect(cfg.ok).toBe(true);
    if (cfg.ok) expect(cfg.value.roles).toBeUndefined();
  });
});

describe("loadConfig — apiStyle + protected", () => {
  it("accepts apiStyle on a target and resolves protected relative to the config", async () => {
    const io = fakeIo({
      "/proj/camis.config.json": JSON.stringify({
        ir: "./camis.json",
        protected: "./overlay",
        targets: [{ target: "filament", out: "./laravel", apiStyle: "strapi" }],
      }),
    });
    const r = await loadConfig(io, "camis.config.json");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.protected).toBe("/proj/overlay");
    expect(r.value.targets[0]?.apiStyle).toBe("strapi");
  });
  it("rejects an unknown apiStyle", async () => {
    const io = fakeIo({
      "/proj/camis.config.json": JSON.stringify({
        ir: "./camis.json",
        targets: [{ target: "filament", out: "./laravel", apiStyle: "graphql" }],
      }),
    });
    expect((await loadConfig(io, "camis.config.json")).ok).toBe(false);
  });
});
