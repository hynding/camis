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
        { type: "dynamicZone", name: "body", components: ["Seo"] },
      ],
    },
  ],
  components: [{ name: "Seo", fields: [{ type: "string", name: "metaTitle" }] }],
});

const io = (lines: string[], materializeSpy = vi.fn(() => Promise.resolve())): Io => ({
  readFile: (p) => Promise.resolve(p.endsWith("camis.config.json") ? config : ir),
  writeFile: () => Promise.resolve(),
  materialize: materializeSpy,
  copyDir: () => Promise.resolve(),
  exec: () => Promise.resolve(0),
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
      copyDir: () => Promise.resolve(),
      exec: () => Promise.resolve(0),
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

describe("generateCommand — roles", () => {
  const irWithOwner = JSON.stringify({
    version: 1,
    contentTypes: [
      {
        name: "Note",
        kind: "collection",
        fields: [{ type: "text", name: "text" }],
      },
    ],
    components: [],
  });
  const configWithRoles = JSON.stringify({
    ir: "./camis.json",
    roles: "./camis.roles.json",
    targets: [{ target: "filament", out: "./out/admin" }],
  });
  const rolesJson = JSON.stringify([
    { name: "admin", grants: [{ contentType: "Note", actions: ["read", "create"] }] },
  ]);

  const rolesIo = (lines: string[], roles: string): Io => ({
    readFile: (p) =>
      Promise.resolve(
        p.endsWith("camis.config.json")
          ? configWithRoles
          : p.endsWith("camis.roles.json")
            ? roles
            : irWithOwner,
      ),
    writeFile: () => Promise.resolve(),
    materialize: () => Promise.resolve(),
    copyDir: () => Promise.resolve(),
    exec: () => Promise.resolve(0),
    out: (l) => lines.push(l),
    cwd: "/p",
  });

  it("emits permission files when a roles file is configured", async () => {
    const lines: string[] = [];
    const seen: GenerationResult[] = [];
    const io: Io = {
      ...rolesIo(lines, rolesJson),
      materialize: (result) => {
        seen.push(result);
        return Promise.resolve();
      },
    };
    const code = await generateCommand("camis.config.json", io, { write: true });
    expect(code).toBe(0);
    const paths = seen[0]!.files.map((f) => f.path);
    expect(paths).toContain("database/seeders/RolePermissionSeeder.php");
    expect(paths).toContain("app/Policies/NotePolicy.php");
  });

  it("exits 1 when a grant references an unknown content type", async () => {
    const lines: string[] = [];
    const badRoles = JSON.stringify([
      { name: "admin", grants: [{ contentType: "Missing", actions: ["read"] }] },
    ]);
    const code = await generateCommand("camis.config.json", rolesIo(lines, badRoles), {
      write: false,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("unknown_grant_content_type");
  });

  it("exits 1 on a malformed roles file", async () => {
    const lines: string[] = [];
    const code = await generateCommand("camis.config.json", rolesIo(lines, '{"not":"an array"}'), {
      write: false,
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("roles");
  });
});

const rolesObj = JSON.stringify({
  defaultRole: "authenticated",
  roles: [{ name: "authenticated", grants: [{ contentType: "Article", actions: ["read"] }] }],
});
const filamentConfig = JSON.stringify({
  ir: "./camis.json",
  roles: "./roles.json",
  protected: "./overlay",
  targets: [{ target: "filament", out: "./laravel", apiStyle: "strapi" }],
});
const plainIr = JSON.stringify({
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
  ],
  components: [],
});

describe("generateCommand strapi style", () => {
  const files: Record<string, string> = {
    "/p/camis.config.json": filamentConfig,
    "/p/camis.json": plainIr,
    "/p/roles.json": rolesObj,
  };
  const mk = (
    lines: string[],
    materializeSpy = vi.fn(() => Promise.resolve()),
    copySpy = vi.fn(() => Promise.resolve()),
  ): Io => ({
    readFile: (p) =>
      p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error(`ENOENT ${p}`)),
    writeFile: () => Promise.resolve(),
    materialize: materializeSpy,
    copyDir: copySpy,
    exec: () => Promise.resolve(0),
    out: (l) => lines.push(l),
    cwd: "/p",
  });
  it("accepts the roles-file object form and emits the Strapi-style auth controller", async () => {
    const lines: string[] = [];
    const spy = vi.fn(() => Promise.resolve()) as MockedFunction<
      (r: GenerationResult, d: string) => Promise<void>
    >;
    const code = await generateCommand("camis.config.json", mk(lines, spy), { write: true });
    expect(code).toBe(0);
    const paths = spy.mock.calls[0]![0].files.map((f) => f.path);
    expect(paths).toContain("app/Http/Controllers/Api/AuthController.php");
  });
  it("mirrors the protected directory into out after materializing", async () => {
    const lines: string[] = [];
    const copy = vi.fn(() => Promise.resolve());
    await generateCommand("camis.config.json", mk(lines, undefined, copy), { write: true });
    expect(copy).toHaveBeenCalledWith("/p/overlay", "/p/laravel");
  });
  it("does not copy on dry-run", async () => {
    const copy = vi.fn(() => Promise.resolve());
    await generateCommand("camis.config.json", mk([], undefined, copy), { write: false });
    expect(copy).not.toHaveBeenCalled();
  });
});
