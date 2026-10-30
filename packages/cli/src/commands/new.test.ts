import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Io } from "../io";
import { newCommand } from "./new";

interface ExecCall {
  cmd: string;
  args: string[];
  cwd: string;
}

// Written files are readable back, so `new` can build from the files it just wrote.
const memoryIo = (opts: { files?: Record<string, string>; execResults?: number[] } = {}) => {
  const files: Record<string, string> = { ...opts.files };
  const execResults = opts.execResults ?? [];
  const calls: ExecCall[] = [];
  const lines: string[] = [];
  const materialized: string[] = [];
  const copied: { src: string; dest: string }[] = [];
  const io: Io = {
    readFile: (p) =>
      p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error(`ENOENT ${p}`)),
    writeFile: (p, c) => {
      files[p] = c;
      return Promise.resolve();
    },
    materialize: (_result, dest) => {
      materialized.push(dest);
      return Promise.resolve();
    },
    makeDir: () => Promise.resolve(),
    copyDir: (src, dest) => {
      copied.push({ src, dest });
      return Promise.resolve();
    },
    exec: (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      return Promise.resolve(execResults[calls.length - 1] ?? 0);
    },
    out: (l) => lines.push(l),
    cwd: "/work",
  };
  return { io, files, calls, lines, materialized, copied };
};

const json = (files: Record<string, string>, path: string): Record<string, unknown> =>
  JSON.parse(files[path]!) as Record<string, unknown>;

describe("newCommand — project files", () => {
  it("writes the IR, config, roles and project files for the vanilla template", async () => {
    const { io, files } = memoryIo();
    expect(await newCommand("my-project", io, {})).toBe(0);
    expect(Object.keys(files).sort()).toEqual([
      "/work/my-project/.gitignore",
      "/work/my-project/README.md",
      "/work/my-project/camis.config.json",
      "/work/my-project/camis.json",
      "/work/my-project/protected/.gitkeep",
      "/work/my-project/roles.json",
    ]);
    expect(json(files, "/work/my-project/camis.json")).toEqual({
      version: 1,
      contentTypes: [],
      components: [],
    });
    expect(files["/work/my-project/.gitignore"]).toContain("generated/");
  });

  it("targets Strapi by default, named after the project directory", async () => {
    const { io, files } = memoryIo();
    await newCommand("my-project", io, {});
    expect(json(files, "/work/my-project/camis.config.json")).toEqual({
      ir: "./camis.json",
      roles: "./roles.json",
      protected: "./protected",
      targets: [{ target: "strapi", out: "./generated/strapi", projectName: "my-project" }],
    });
  });

  it("serves the Strapi API style from a filament target and honors the express dialect", async () => {
    const { io, files } = memoryIo();
    await newCommand("blog", io, { targets: ["filament", "express"], dialect: "pgsql" });
    const config = json(files, "/work/blog/camis.config.json");
    expect(config.targets).toEqual([
      { target: "filament", out: "./generated/filament", projectName: "blog", apiStyle: "strapi" },
      { target: "express", out: "./generated/express", projectName: "blog", dialect: "pgsql" },
    ]);
  });

  it("writes create-strapi-app's blog for the example template", async () => {
    const { io, files } = memoryIo();
    await newCommand("blog", io, { template: "example" });
    const ir = json(files, "/work/blog/camis.json") as { contentTypes: { name: string }[] };
    expect(ir.contentTypes.map((ct) => ct.name)).toContain("Article");
  });

  it("refuses to write over an existing camis project", async () => {
    const { io, files, lines } = memoryIo({
      files: { "/work/taken/camis.config.json": "{}" },
    });
    expect(await newCommand("taken", io, {})).toBe(1);
    expect(lines.join("\n")).toContain("already contains a camis project");
    expect(files["/work/taken/camis.config.json"]).toBe("{}");
  });

  it("rejects an unknown template", async () => {
    const { io, lines } = memoryIo();
    expect(await newCommand("p", io, { template: "nope" })).toBe(1);
    expect(lines.join("\n")).toContain('unknown template "nope"');
  });

  it("rejects an unknown target", async () => {
    const { io, lines } = memoryIo();
    expect(await newCommand("p", io, { targets: ["drupal"] })).toBe(1);
    expect(lines.join("\n")).toContain('unknown target "drupal"');
  });

  it("rejects --dialect without an express target", async () => {
    const { io, lines } = memoryIo();
    expect(await newCommand("p", io, { dialect: "mysql" })).toBe(1);
    expect(lines.join("\n")).toContain("--dialect applies only to the express target");
  });
});

describe("newCommand — from an existing Strapi project", () => {
  const strapiProject = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "camis-new-from-strapi-"));
    const ctDir = join(dir, "src/api/page/content-types/page");
    await mkdir(ctDir, { recursive: true });
    await writeFile(
      join(ctDir, "schema.json"),
      JSON.stringify({
        kind: "collectionType",
        info: { singularName: "page", pluralName: "pages", displayName: "Page" },
        attributes: {
          title: { type: "string", required: true },
          related: { type: "relation", relation: "morphToMany" },
        },
      }),
    );
    return dir;
  };

  it("imports the content model and reports what it dropped", async () => {
    const source = await strapiProject();
    const { io, files, lines } = memoryIo();
    expect(await newCommand("migrated", io, { fromStrapi: source })).toBe(0);
    const ir = json(files, "/work/migrated/camis.json") as { contentTypes: { name: string }[] };
    expect(ir.contentTypes.map((ct) => ct.name)).toEqual(["Page"]);
    expect(lines.join("\n")).toMatch(/⚠ morphRelation @ Page\.related/);
  });

  it("does not combine with --template", async () => {
    const source = await strapiProject();
    const { io, lines } = memoryIo();
    expect(await newCommand("p", io, { fromStrapi: source, template: "example" })).toBe(1);
    expect(lines.join("\n")).toContain("--from-strapi and --template");
  });

  it("takes its roles from the project's export instead of Strapi's defaults", async () => {
    const source = await strapiProject();
    const archive = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../adapter-filament/src/strapi-api/__fixtures__/transfer/strapi-php-export.tar.gz",
    );
    const { io, files } = memoryIo();
    expect(
      await newCommand("migrated", io, {
        fromStrapi: source,
        strapiRoles: { archive },
        skipScaffold: true,
        skipBuild: true,
      }),
    ).toBe(0);
    const roles = json(files, "/work/migrated/roles.json") as {
      roles: { name: string; grants: { contentType: string }[] }[];
    };
    expect(roles.roles.map((r) => r.name).slice(0, 3)).toEqual([
      "public",
      "authenticated",
      "editor",
    ]);
    // Only Page is in this project: the archive's grants on its other types are reported.
    expect(roles.roles[1]?.grants.map((g) => g.contentType)).toEqual(["File", "Page", "User"]);
  });

  it("reads roles only along with --from-strapi", async () => {
    const { io, lines } = memoryIo();
    expect(await newCommand("p", io, { strapiRoles: { archive: "export.tar.gz" } })).toBe(1);
    expect(lines.join("\n")).toContain(
      "--roles-from reads a Strapi export, so it needs --from-strapi",
    );
  });

  it("fails on a directory with no Strapi schemas", async () => {
    const empty = await mkdtemp(join(tmpdir(), "camis-new-empty-"));
    const { io, lines } = memoryIo();
    expect(await newCommand("p", io, { fromStrapi: empty })).toBe(1);
    expect(lines.join("\n")).toContain("no Strapi content types or components");
  });

  // Strapi's admin roles live outside its users-permissions export, so a migrated project would
  // otherwise have no role that may sign in to the admin.
  it("adds a super-admin role, flagged admin, with every action on every content type", async () => {
    const source = await strapiProject();
    const { io, files } = memoryIo();
    expect(
      await newCommand("migrated", io, { fromStrapi: source, skipScaffold: true, skipBuild: true }),
    ).toBe(0);
    const roles = json(files, "/work/migrated/roles.json") as {
      defaultRole: string;
      roles: { name: string; admin?: boolean; grants: unknown[] }[];
    };
    expect(roles.defaultRole).toBe("authenticated");
    expect(roles.roles.map((r) => r.name)).toEqual(["public", "authenticated", "super-admin"]);
    expect(roles.roles[2]).toMatchObject({
      admin: true,
      grants: [{ contentType: "Page", actions: ["create", "read", "update", "delete"] }],
    });
  });

  it("declares the media library a media field uses, so the super-admin may manage its files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "camis-new-from-strapi-media-"));
    const ctDir = join(dir, "src/api/page/content-types/page");
    await mkdir(ctDir, { recursive: true });
    await writeFile(
      join(ctDir, "schema.json"),
      JSON.stringify({
        kind: "collectionType",
        info: { singularName: "page", pluralName: "pages", displayName: "Page" },
        attributes: { cover: { type: "media", multiple: false } },
      }),
    );
    const { io, files } = memoryIo();
    await newCommand("migrated", io, { fromStrapi: dir, skipScaffold: true, skipBuild: true });
    const ir = json(files, "/work/migrated/camis.json") as {
      contentTypes: { name: string; builtin?: string }[];
    };
    expect(ir.contentTypes).toContainEqual({
      name: "File",
      kind: "collection",
      builtin: "file",
      fields: [],
    });
    const roles = json(files, "/work/migrated/roles.json") as {
      roles: { name: string; grants: { contentType: string }[] }[];
    };
    expect(roles.roles[2]?.grants.map((g) => g.contentType)).toEqual(["Page", "File"]);
  });

  it("gives the super-admin the archive's builtin types too, after the archive's roles", async () => {
    const source = await strapiProject();
    const archive = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../adapter-filament/src/strapi-api/__fixtures__/transfer/strapi-php-export.tar.gz",
    );
    const { io, files } = memoryIo();
    await newCommand("migrated", io, {
      fromStrapi: source,
      strapiRoles: { archive },
      skipScaffold: true,
      skipBuild: true,
    });
    const roles = json(files, "/work/migrated/roles.json") as {
      roles: { name: string; admin?: boolean; grants: { contentType: string }[] }[];
    };
    expect(roles.roles.map((r) => r.name)).toEqual([
      "public",
      "authenticated",
      "editor",
      "super-admin",
    ]);
    expect(roles.roles[3]?.grants.map((g) => g.contentType)).toEqual(["Page", "File", "User"]);
  });
});

describe("newCommand — the admin role of a template", () => {
  it("lets the super-admin publish the types with drafts", async () => {
    const { io, files } = memoryIo();
    await newCommand("blog", io, { template: "example", skipScaffold: true, skipBuild: true });
    const roles = json(files, "/work/blog/roles.json") as {
      roles: { name: string; grants: { contentType: string; actions: string[] }[] }[];
    };
    const superAdmin = roles.roles.find((r) => r.name === "super-admin");
    expect(superAdmin?.grants.find((g) => g.contentType === "Article")?.actions).toEqual([
      "create",
      "read",
      "update",
      "delete",
      "publish",
    ]);
    expect(superAdmin?.grants.find((g) => g.contentType === "Author")?.actions).not.toContain(
      "publish",
    );
  });

  it("names camis:admin among a filament project's next steps", async () => {
    const { io, lines } = memoryIo();
    await newCommand("p", io, { targets: ["filament"], skipScaffold: true, skipBuild: true });
    expect(lines.join("\n")).toContain("php artisan camis:admin");
  });
});

// Laravel 12's skeleton, the shape scaffold patches.
const STOCK_BOOTSTRAP = `<?php

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        //
    })->create();
`;

describe("newCommand — scaffold and build", () => {
  it("builds every target into generated/", async () => {
    const { io, materialized } = memoryIo();
    expect(await newCommand("p", io, { targets: ["strapi", "express"] })).toBe(0);
    expect(materialized).toEqual(["/work/p/generated/strapi", "/work/p/generated/express"]);
  });

  it("scaffolds the Laravel host app before building a filament target", async () => {
    const { io, files, calls, materialized } = memoryIo();
    files["/work/p/generated/filament/app/Models/User.php"] =
      "class User extends Authenticatable\n{\n    use HasFactory, Notifiable;\n}\n";
    files["/work/p/generated/filament/bootstrap/app.php"] = STOCK_BOOTSTRAP;
    expect(await newCommand("p", io, { targets: ["filament"] })).toBe(0);
    expect(calls[0]).toMatchObject({
      cmd: "composer",
      args: [
        "create-project",
        "laravel/laravel:^12",
        "/work/p/generated/filament",
        "--no-interaction",
      ],
    });
    expect(materialized).toEqual(["/work/p/generated/filament"]);
  });

  it("stops before building when the scaffold fails", async () => {
    const { io, materialized, lines } = memoryIo({ execResults: [1] });
    expect(await newCommand("p", io, { targets: ["filament"] })).toBe(1);
    expect(materialized).toEqual([]);
    expect(lines.join("\n")).toContain("exited 1");
  });

  it("skips the scaffold and the build when asked", async () => {
    const { io, calls, materialized, lines } = memoryIo();
    const code = await newCommand("p", io, {
      targets: ["filament"],
      skipScaffold: true,
      skipBuild: true,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(materialized).toEqual([]);
    expect(lines.join("\n")).toContain("camis scaffold filament generated/filament");
  });

  it("finishes with the next steps", async () => {
    const { io, lines } = memoryIo();
    await newCommand("p", io, {});
    expect(lines.join("\n")).toContain("✓ created camis project p");
  });
});
