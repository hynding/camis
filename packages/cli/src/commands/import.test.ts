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
          related: { type: "relation", relation: "morphToMany" },
        },
      }),
    );
    const lines: string[] = [];
    const code = await importCommand("strapi", dir, join(dir, "ir.json"), memIo({}, lines, {}));
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/⚠ morphRelation @ Page\.related/);
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
