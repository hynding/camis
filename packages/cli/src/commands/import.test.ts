import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { importCommand } from "./import";
import type { Io } from "../io";

const memIo = (
  files: Record<string, string>,
  lines: string[],
  written: Record<string, string>,
): Io => ({
  readFile: (p) =>
    p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error(`ENOENT ${p}`)),
  writeFile: (p, c) => {
    written[p] = c;
    return Promise.resolve();
  },
  materialize: () => Promise.resolve(),
  makeDir: () => Promise.resolve(),
  copyDir: () => Promise.resolve(),
  exec: () => Promise.resolve(0),
  out: (l) => lines.push(l),
  cwd: "/p",
});

describe("importCommand", () => {
  it("imports an Express camis.schema.json and writes the IR", async () => {
    const schema = JSON.stringify({
      version: 1,
      contentTypes: [
        {
          name: "Article",
          kind: "collection",
          fields: [{ type: "string", name: "title", required: true }],
        },
      ],
      components: [],
    });
    const lines: string[] = [];
    const written: Record<string, string> = {};
    const io = memIo({ "/p/proj/camis.schema.json": schema }, lines, written);
    const code = await importCommand("express", "proj", "out.json", io);
    expect(code).toBe(0);
    expect(written["/p/out.json"]).toBeDefined();
    expect(JSON.parse(written["/p/out.json"]!).contentTypes[0].name).toBe("Article");
  });
  it("errors on filament (no importer)", async () => {
    const lines: string[] = [];
    const code = await importCommand("filament", "proj", "out.json", memIo({}, lines, {}));
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("no importer");
  });
  it("imports a minimal Strapi project from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "camis-cli-strapi-"));
    const ctDir = join(dir, "src/api/article/content-types/article");
    await (await import("node:fs/promises")).mkdir(ctDir, { recursive: true });
    await writeFile(
      join(ctDir, "schema.json"),
      JSON.stringify({
        kind: "collectionType",
        info: { singularName: "article", pluralName: "articles", displayName: "Article" },
        attributes: { title: { type: "string", required: true } },
      }),
    );
    const lines: string[] = [];
    const written: Record<string, string> = {};
    const io = memIo({}, lines, written);
    const code = await importCommand("strapi", dir, join(dir, "ir.json"), io);
    expect(code).toBe(0);
    expect(Object.values(written)[0]).toContain('"Article"');
  });
  // A Strapi project's config (upload and email providers, API page sizes, sessions) becomes the
  // Laravel app's env.
  it("writes the env a Strapi project's config/plugins maps to, beside the IR", async () => {
    const dir = await mkdtemp(join(tmpdir(), "camis-cli-strapi-providers-"));
    const ctDir = join(dir, "src/api/article/content-types/article");
    await mkdir(ctDir, { recursive: true });
    await writeFile(
      join(ctDir, "schema.json"),
      JSON.stringify({
        kind: "collectionType",
        info: { singularName: "article", pluralName: "articles", displayName: "Article" },
        attributes: { title: { type: "string" } },
      }),
    );
    await mkdir(join(dir, "config"));
    await writeFile(
      join(dir, "config/plugins.js"),
      `module.exports = ({ env }) => ({
  upload: { config: { provider: "uploadcare" } },
  email: { config: { provider: "sendmail", settings: { defaultFrom: env("FROM") } } },
});\n`,
    );
    const lines: string[] = [];
    const written: Record<string, string> = {};
    const io: Io = {
      ...memIo({}, lines, written),
      capture: () =>
        Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            upload: { config: { provider: "uploadcare" } },
            email: { config: { provider: "sendmail", settings: { defaultFrom: { env: "FROM" } } } },
          }),
        }),
    };
    const code = await importCommand("strapi", dir, join(dir, "ir.json"), io);
    expect(code).toBe(0);
    const env = written[join(dir, "deployment.env")];
    expect(env).toContain("MAIL_MAILER=sendmail\n");
    expect(env).toContain("CAMIS_EMAIL_DEFAULT_FROM=${FROM}\n");
    expect(lines.join("\n")).toMatch(/✓ deployment settings → .*deployment\.env/);
    expect(lines.join("\n")).toContain("uploadProvider");
  });
  it("writes the CORS settings of a Strapi project's config/middlewares", async () => {
    const dir = await mkdtemp(join(tmpdir(), "camis-cli-strapi-cors-"));
    const ctDir = join(dir, "src/api/article/content-types/article");
    await mkdir(ctDir, { recursive: true });
    await writeFile(
      join(ctDir, "schema.json"),
      JSON.stringify({
        kind: "collectionType",
        info: { singularName: "article", pluralName: "articles", displayName: "Article" },
        attributes: { title: { type: "string" } },
      }),
    );
    await mkdir(join(dir, "config"));
    const middlewares = [
      "strapi::errors",
      { name: "strapi::cors", config: { origin: [{ env: "FRONTEND_URL" }], maxAge: 600 } },
    ];
    await writeFile(join(dir, "config/middlewares.js"), "module.exports = [];\n");
    const lines: string[] = [];
    const written: Record<string, string> = {};
    const io: Io = {
      ...memIo({}, lines, written),
      capture: () => Promise.resolve({ code: 0, stdout: JSON.stringify(middlewares) }),
    };
    const code = await importCommand("strapi", dir, join(dir, "ir.json"), io);
    expect(code).toBe(0);
    const env = written[join(dir, "deployment.env")];
    expect(env).toContain("CAMIS_CORS_ORIGIN=${FRONTEND_URL}\nCAMIS_CORS_MAX_AGE=600\n");
  });
  // Strapi's upload plugin is always there: a project with media fields gets the media library's
  // type, as `camis new --from-strapi` gives it, or no role could ever be granted its files.
  it("declares the media library when a Strapi project uses media", async () => {
    const dir = await mkdtemp(join(tmpdir(), "camis-cli-strapi-media-"));
    const ctDir = join(dir, "src/api/article/content-types/article");
    await mkdir(ctDir, { recursive: true });
    await writeFile(
      join(ctDir, "schema.json"),
      JSON.stringify({
        kind: "collectionType",
        info: { singularName: "article", pluralName: "articles", displayName: "Article" },
        attributes: { cover: { type: "media", multiple: false } },
      }),
    );
    const written: Record<string, string> = {};
    const code = await importCommand("strapi", dir, join(dir, "ir.json"), memIo({}, [], written));
    expect(code).toBe(0);
    const document = JSON.parse(written[join(dir, "ir.json")]!) as {
      contentTypes: { name: string; builtin?: string }[];
    };
    expect(document.contentTypes).toContainEqual(
      expect.objectContaining({ name: "File", builtin: "file" }),
    );
  });
  it("declares Strapi's users on a Strapi import, as the users-permissions plugin is always there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "camis-cli-strapi-users-"));
    const ctDir = join(dir, "src/api/page/content-types/page");
    await mkdir(ctDir, { recursive: true });
    await writeFile(
      join(ctDir, "schema.json"),
      JSON.stringify({
        kind: "collectionType",
        info: { singularName: "page", pluralName: "pages", displayName: "Page" },
        attributes: { title: { type: "string" } },
      }),
    );
    const written: Record<string, string> = {};
    expect(await importCommand("strapi", dir, join(dir, "ir.json"), memIo({}, [], written))).toBe(
      0,
    );
    const document = JSON.parse(written[join(dir, "ir.json")]!) as {
      contentTypes: { name: string; builtin?: string }[];
    };
    expect(document.contentTypes).toContainEqual(
      expect.objectContaining({ name: "User", builtin: "user" }),
    );
  });
  // A dropped attribute must be visible: otherwise an import silently loses fields.
  it("prints the capability gaps of a Strapi import", async () => {
    const dir = await mkdtemp(join(tmpdir(), "camis-cli-strapi-gaps-"));
    const ctDir = join(dir, "src/api/page/content-types/page");
    await mkdir(ctDir, { recursive: true });
    await writeFile(
      join(ctDir, "schema.json"),
      JSON.stringify({
        kind: "collectionType",
        info: { singularName: "page", pluralName: "pages", displayName: "Page" },
        attributes: {
          title: { type: "string" },
          related: { type: "relation", relation: "morphMany", target: "api::page.page" },
        },
      }),
    );
    const lines: string[] = [];
    const code = await importCommand("strapi", dir, join(dir, "ir.json"), memIo({}, lines, {}));
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/⚠ morphRelation @ Page\.related/);
  });
  it("names each file of custom code a Strapi project would leave behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "camis-cli-strapi-code-"));
    const ctDir = join(dir, "src/api/page/content-types/page");
    await mkdir(ctDir, { recursive: true });
    await writeFile(
      join(ctDir, "schema.json"),
      JSON.stringify({
        kind: "collectionType",
        info: { singularName: "page", pluralName: "pages", displayName: "Page" },
        attributes: { title: { type: "string" } },
      }),
    );
    await mkdir(join(dir, "src/policies"), { recursive: true });
    await writeFile(join(dir, "src/policies/is-owner.ts"), "export default () => true;");
    const lines: string[] = [];
    const code = await importCommand("strapi", dir, join(dir, "ir.json"), memIo({}, lines, {}));
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(
      /⚠ customPolicy @ src\/policies\/is-owner\.ts — policy code is not imported; declare it in the IR's policies/,
    );
  });
  it("passes --upsert-by through to the Strapi importer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "camis-import-"));
    await mkdir(join(dir, "src/api/note/content-types/note"), { recursive: true });
    await writeFile(
      join(dir, "src/api/note/content-types/note/schema.json"),
      JSON.stringify({
        kind: "collectionType",
        collectionName: "notes",
        info: { singularName: "note", pluralName: "notes", displayName: "Note" },
        attributes: { recordId: { type: "string", unique: true } },
      }),
    );
    const lines: string[] = [];
    const written: Record<string, string> = {};
    const code = await importCommand("strapi", dir, "/p/out.json", memIo({}, lines, written), {
      upsertBy: "recordId",
    });
    expect(code).toBe(0);
    expect(JSON.parse(written["/p/out.json"]!).contentTypes[0].options.upsertBy).toBe("recordId");
  });

  // strapi-php's export of the Filament target's transfer fixture: its roles were set through
  // strapi-php's admin to the fixture's grants for these types, plus an Editor role of its own.
  const ARCHIVE = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../adapter-filament/src/strapi-api/__fixtures__/transfer/strapi-php-export.tar.gz.enc",
  );
  const archiveProject = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "camis-import-roles-"));
    const types: [string, string, Record<string, unknown>][] = [
      ["article", "articles", { pluginOptions: { i18n: { localized: true } } }],
      ["author", "authors", {}],
      ["book", "books", {}],
      ["category", "categories", { pluginOptions: { i18n: { localized: true } } }],
      ["genre", "genres", {}],
      ["landing", "landings", { options: { draftAndPublish: true } }],
      [
        "page",
        "pages",
        { options: { draftAndPublish: true }, pluginOptions: { i18n: { localized: true } } },
      ],
      ["post", "posts", { options: { draftAndPublish: true } }],
      ["topic", "topics", { options: { draftAndPublish: true } }],
    ];
    for (const [singularName, pluralName, extra] of types) {
      const ctDir = join(dir, `src/api/${singularName}/content-types/${singularName}`);
      await mkdir(ctDir, { recursive: true });
      await writeFile(
        join(ctDir, "schema.json"),
        JSON.stringify({
          kind: "collectionType",
          info: { singularName, pluralName, displayName: singularName },
          attributes: { title: { type: "string" } },
          ...extra,
        }),
      );
    }
    return dir;
  };
  const CRUD = ["create", "read", "update", "delete"];

  const ADMIN_DATABASE = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../adapter-strapi/src/import/__fixtures__/strapi-php-admin.db",
  );

  it("adds Strapi's admin roles to the export's, kept apart from a users' role of the same name", async () => {
    const lines: string[] = [];
    const written: Record<string, string> = {};
    const code = await importCommand(
      "strapi",
      await archiveProject(),
      "out.json",
      memIo({}, lines, written),
      {
        roles: { archive: ARCHIVE, key: "camis-fixture-key", out: "roles.json" },
        adminRoles: ADMIN_DATABASE,
      },
    );
    expect(code, lines.join("\n")).toBe(0);
    const roles = JSON.parse(written["/p/roles.json"]!) as {
      roles: { name: string; admin?: boolean; grants: { contentType: string }[] }[];
    };
    expect(roles.roles.map((r) => r.name)).toEqual([
      "public",
      "authenticated",
      "editor",
      "super-admin",
      "admin-editor",
      "author",
      "content-writer",
    ]);
    expect(roles.roles.filter((r) => r.admin === true).map((r) => r.name)).toEqual([
      "super-admin",
      "admin-editor",
      "author",
      "content-writer",
    ]);
  });

  it("writes the default users' roles beside the admin roles when there is no export", async () => {
    const lines: string[] = [];
    const written: Record<string, string> = {};
    const code = await importCommand(
      "strapi",
      await archiveProject(),
      "out.json",
      memIo({}, lines, written),
      { adminRoles: ADMIN_DATABASE },
    );
    expect(code, lines.join("\n")).toBe(0);
    const roles = JSON.parse(written["/p/roles.json"]!) as { roles: { name: string }[] };
    expect(roles.roles.map((r) => r.name)).toEqual([
      "public",
      "authenticated",
      "super-admin",
      "editor",
      "author",
      "content-writer",
    ]);
  });

  it("says why it cannot read the admin roles", async () => {
    const lines: string[] = [];
    const code = await importCommand(
      "strapi",
      await archiveProject(),
      "out.json",
      memIo({}, lines, {}),
      { adminRoles: "missing.db" },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(
      /✗ cannot read admin roles from missing\.db: \S*missing\.db is neither a SQLite file nor a mysql:\/\/ or postgres:\/\/ URL/,
    );
  });

  it("brings a Strapi export's roles and permissions in as the IR's roles", async () => {
    const lines: string[] = [];
    const written: Record<string, string> = {};
    const code = await importCommand(
      "strapi",
      await archiveProject(),
      "/p/camis.json",
      memIo({}, lines, written),
      { roles: { archive: ARCHIVE, key: "camis-fixture-key", out: "roles.json" } },
    );
    expect(code, lines.join("\n")).toBe(0);
    expect(JSON.parse(written["/p/roles.json"]!)).toEqual({
      defaultRole: "authenticated",
      roles: [
        {
          name: "public",
          description: "Default role given to unauthenticated user.",
          grants: [{ contentType: "Book", actions: ["read"] }],
        },
        {
          name: "authenticated",
          description: "Default role given to authenticated user.",
          grants: [
            { contentType: "Article", actions: CRUD },
            { contentType: "Author", actions: CRUD },
            { contentType: "Book", actions: CRUD },
            { contentType: "Category", actions: CRUD },
            { contentType: "File", actions: CRUD },
            { contentType: "Genre", actions: CRUD },
            { contentType: "Landing", actions: [...CRUD, "publish"] },
            { contentType: "Page", actions: [...CRUD, "publish"] },
            { contentType: "Post", actions: [...CRUD, "publish"] },
            { contentType: "Topic", actions: [...CRUD, "publish"] },
            { contentType: "User", actions: ["read"] },
          ],
        },
        {
          name: "editor",
          description: "Edits articles.",
          grants: [{ contentType: "Article", actions: ["read", "update"] }],
        },
      ],
    });
    // The media library and the users its grants name join the IR.
    const document = JSON.parse(written["/p/camis.json"]!) as {
      contentTypes: { name: string; builtin?: string }[];
    };
    expect(document.contentTypes.filter((ct) => ct.builtin !== undefined)).toEqual([
      expect.objectContaining({ name: "File", builtin: "file" }),
      expect.objectContaining({ name: "User", builtin: "user" }),
    ]);
    // Editor's Page find has no camis grant of its own (read is find and findOne).
    expect(lines.join("\n")).toMatch(/⚠ strapiPermission @ Page\.editor — .*api::page\.page\.find/);
  });

  it("says why when the export cannot be read", async () => {
    const lines: string[] = [];
    const code = await importCommand(
      "strapi",
      await archiveProject(),
      "/p/camis.json",
      memIo({}, lines, {}),
      {
        roles: { archive: ARCHIVE, key: "wrong", out: "roles.json" },
      },
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("cannot be decrypted with this key");
  });

  it("reads roles only from a Strapi export", async () => {
    const lines: string[] = [];
    const code = await importCommand("express", "proj", "out.json", memIo({}, lines, {}), {
      roles: { archive: ARCHIVE, out: "roles.json" },
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("applies only to `import strapi`");
  });
});
