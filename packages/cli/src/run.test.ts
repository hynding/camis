import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  copyDir: (s, d) => cp(s, d, { recursive: true, force: true }),
  exec: () => Promise.resolve(0),
  out: (l) => lines.push(l),
  cwd,
});

describe("run", () => {
  it("prints usage and exits 1 on an unknown command", async () => {
    const io: Io = {
      readFile: () => Promise.resolve(""),
      writeFile: () => Promise.resolve(),
      materialize: () => Promise.resolve(),
      copyDir: () => Promise.resolve(),
      exec: () => Promise.resolve(0),
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

  it("imports a Strapi project with plugin user relations end-to-end", async () => {
    tmp = await mkdtemp(join(tmpdir(), "camis-cli-user-"));
    const schemaDir = join(tmp, "strapi-app/src/api/note/content-types/note");
    await mkdir(schemaDir, { recursive: true });
    await writeFile(
      join(schemaDir, "schema.json"),
      JSON.stringify({
        kind: "collectionType",
        collectionName: "notes",
        info: { singularName: "note", pluralName: "notes", displayName: "Note" },
        options: {},
        pluginOptions: {},
        attributes: {
          text: { type: "text" },
          owner: {
            type: "relation",
            relation: "manyToOne",
            target: "plugin::users-permissions.user",
          },
        },
      }),
    );
    const io = realIo(tmp);
    const importCode = await run(
      ["import", "strapi", join(tmp, "strapi-app"), "--out", join(tmp, "camis.json")],
      io,
    );
    expect(importCode).toBe(0);
    const ir = JSON.parse(await readFile(join(tmp, "camis.json"), "utf8")) as {
      contentTypes: { name: string; builtin?: string }[];
    };
    expect(ir.contentTypes.find((ct) => ct.name === "User")?.builtin).toBe("user");

    await writeFile(
      join(tmp, "camis.config.json"),
      JSON.stringify({
        ir: "./camis.json",
        targets: [{ target: "filament", out: "./generated/admin" }],
      }),
    );
    const genCode = await run(["generate", "--config", join(tmp, "camis.config.json")], io);
    expect(genCode).toBe(0);
    expect(lines.some((l) => l.includes("filament:"))).toBe(true);
  });
});

describe("run — import strapi --roles-from", () => {
  it("writes the export's roles beside the IR, and a build takes both", async () => {
    tmp = await mkdtemp(join(tmpdir(), "camis-cli-roles-"));
    const schemaDir = join(tmp, "strapi-app/src/api/book/content-types/book");
    await mkdir(schemaDir, { recursive: true });
    await writeFile(
      join(schemaDir, "schema.json"),
      JSON.stringify({
        kind: "collectionType",
        info: { singularName: "book", pluralName: "books", displayName: "Book" },
        attributes: { title: { type: "string" } },
      }),
    );
    const archive = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../adapter-filament/src/strapi-api/__fixtures__/transfer/strapi-php-export.tar.gz.enc",
    );
    const io = realIo(tmp);
    const code = await run(
      [
        "import",
        "strapi",
        join(tmp, "strapi-app"),
        "--out",
        join(tmp, "camis.json"),
        "--roles-from",
        archive,
        "--key",
        "camis-fixture-key",
        "--roles-out",
        join(tmp, "roles.json"),
      ],
      io,
    );
    expect(code, lines.join("\n")).toBe(0);
    const roles = JSON.parse(await readFile(join(tmp, "roles.json"), "utf8")) as {
      roles: { name: string; grants: unknown[] }[];
    };
    expect(roles.roles.find((r) => r.name === "public")?.grants).toEqual([
      { contentType: "Book", actions: ["read"] },
    ]);
    await writeFile(
      join(tmp, "camis.config.json"),
      JSON.stringify({
        ir: "./camis.json",
        roles: "./roles.json",
        targets: [{ target: "filament", out: "./generated/admin", apiStyle: "strapi" }],
      }),
    );
    expect(await run(["generate", "--config", join(tmp, "camis.config.json")], io)).toBe(0);
  });
});

describe("run — scaffold --storage", () => {
  // Only bootstrap/app.php exists: the composer.json probe must still miss (or the scaffold
  // refuses the directory), while the strapi path's bootstrap patch must find its file.
  const BOOTSTRAP = `return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        //
    })->create();
`;

  const fakeIo = (): { io: Io; execCalls: string[][] } => {
    const execCalls: string[][] = [];
    const io: Io = {
      readFile: (p) =>
        p.endsWith("bootstrap/app.php")
          ? Promise.resolve(BOOTSTRAP)
          : Promise.reject(new Error(`ENOENT ${p}`)),
      writeFile: () => Promise.resolve(),
      materialize: () => Promise.resolve(),
      copyDir: () => Promise.resolve(),
      exec: (cmd, args) => {
        execCalls.push([cmd, ...args]);
        return Promise.resolve(0);
      },
      out: (l) => lines.push(l),
      cwd: "/proj",
    };
    return { io, execCalls };
  };

  it("rejects a --storage value other than laravel or strapi", async () => {
    const { io, execCalls } = fakeIo();
    const code = await run(["scaffold", "filament", "app", "--storage", "cockroachdb"], io);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("✗ scaffold --storage must be laravel or strapi");
    expect(execCalls).toEqual([]);
  });

  it("passes --storage strapi through to scaffoldCommand", async () => {
    const { io, execCalls } = fakeIo();
    const code = await run(["scaffold", "filament", "app", "--storage", "strapi"], io);
    expect(code).toBe(0);
    expect(execCalls).toEqual([
      ["composer", "create-project", "laravel/laravel:^12", "/proj/app", "--no-interaction"],
      ["composer", "require", "firebase/php-jwt", "visus/cuid2", "--no-interaction"],
    ]);
  });

  it("defaults --storage to laravel when omitted", async () => {
    const { io, execCalls } = fakeIo();
    const code = await run(["scaffold", "filament", "app"], io);
    expect(code).toBe(1); // User.php read fails against this fake Io; sequence still runs first
    expect(execCalls.length).toBeGreaterThan(2);
  });
});

describe("run — new", () => {
  const fsIo = (cwd: string): Io => ({
    ...realIo(cwd),
    writeFile: async (p, c) => {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, c);
    },
  });

  it("needs a directory", async () => {
    const io = fsIo("/nowhere");
    expect(await run(["new"], io)).toBe(1);
    expect(lines.join("\n")).toContain("✗ new needs <dir>");
  });

  it("EXIT CRITERIA: creates the example project and builds Strapi + Express from it", async () => {
    tmp = await mkdtemp(join(tmpdir(), "camis-cli-new-"));
    const code = await run(
      ["new", "blog", "--template", "example", "--targets", "strapi,express"],
      fsIo(tmp),
    );
    expect(code).toBe(0);
    const article = await readFile(
      join(tmp, "blog/generated/strapi/src/api/article/content-types/article/schema.json"),
      "utf8",
    );
    expect(JSON.parse(article).attributes.cover.allowedTypes).toEqual([
      "images",
      "files",
      "videos",
    ]);
    expect(await readFile(join(tmp, "blog/generated/express/package.json"), "utf8")).toBeTruthy();

    // A later `camis build` from inside the project regenerates the same output.
    const projectIo = fsIo(join(tmp, "blog"));
    expect(await run(["build"], projectIo)).toBe(0);
    expect(
      await readFile(
        join(tmp, "blog/generated/strapi/src/api/article/content-types/article/schema.json"),
        "utf8",
      ),
    ).toBe(article);
  });

  it("parses --targets, --dialect and the skip flags", async () => {
    tmp = await mkdtemp(join(tmpdir(), "camis-cli-new-flags-"));
    const code = await run(
      [
        "new",
        "api",
        "--targets",
        "filament,express",
        "--dialect",
        "mysql",
        "--skip-scaffold",
        "--skip-build",
      ],
      fsIo(tmp),
    );
    expect(code).toBe(0);
    const config = JSON.parse(await readFile(join(tmp, "api/camis.config.json"), "utf8"));
    expect(config.targets.map((t: { target: string }) => t.target)).toEqual([
      "filament",
      "express",
    ]);
    expect(config.targets[1].dialect).toBe("mysql");
  });
});
