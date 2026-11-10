import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IrDocument } from "@camis/ir-schema";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { readStrapiAdminData, readStrapiAdminRoles } from "./read-admin-roles";

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

// The tables as strapi-php 5.56 creates them on SQLite (columns the reader skips left out).
const SCHEMA = `
  CREATE TABLE admin_roles (id INTEGER PRIMARY KEY, document_id VARCHAR(255), name VARCHAR(255), code VARCHAR(255), description VARCHAR(255));
  CREATE TABLE admin_permissions (id INTEGER PRIMARY KEY, document_id VARCHAR(255), "action" VARCHAR(255), action_parameters json, subject VARCHAR(255), properties json, conditions json);
  CREATE TABLE admin_permissions_role_lnk (id INTEGER PRIMARY KEY, permission_id INTEGER, role_id INTEGER, permission_ord float);
`;

let dir = "";
afterEach(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

const database = async (sql: string): Promise<string> => {
  dir = await mkdtemp(join(tmpdir(), "camis-admin-roles-"));
  const path = join(dir, "data.db");
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.close();
  return path;
};

describe("readStrapiAdminData", () => {
  it("reads the admin roles, each permission with its role, and the locales", async () => {
    const path = await database(`${SCHEMA}
      CREATE TABLE i18n_locale (id INTEGER PRIMARY KEY, code VARCHAR(255));
      INSERT INTO i18n_locale (code) VALUES ('en'), ('fr');
      INSERT INTO admin_roles VALUES (2, 'd2', 'Editor', 'strapi-editor', 'Edits.');
      INSERT INTO admin_roles VALUES (1, 'd1', 'Super Admin', 'strapi-super-admin', NULL);
      INSERT INTO admin_permissions VALUES (7, 'p7', 'plugin::content-manager.explorer.read', '{}', 'api::article.article', '{"fields":["title"]}', '["admin::is-creator"]');
      INSERT INTO admin_permissions VALUES (8, 'p8', 'plugin::upload.read', '{}', NULL, '{}', '[]');
      INSERT INTO admin_permissions_role_lnk (permission_id, role_id, permission_ord) VALUES (8, 2, 2), (7, 2, 1);
    `);
    expect(readStrapiAdminData(path)).toEqual({
      roles: [
        { id: 1, name: "Super Admin", code: "strapi-super-admin", description: null },
        { id: 2, name: "Editor", code: "strapi-editor", description: "Edits." },
      ],
      permissions: [
        {
          role: 2,
          action: "plugin::content-manager.explorer.read",
          subject: "api::article.article",
          properties: { fields: ["title"] },
          conditions: ["admin::is-creator"],
        },
        { role: 2, action: "plugin::upload.read", subject: null, properties: {}, conditions: [] },
      ],
      locales: ["en", "fr"],
    });
  });

  it("has no locales when the project has no i18n table", async () => {
    expect(readStrapiAdminData(await database(SCHEMA)).locales).toEqual([]);
  });

  it("says what it is when it is not a Strapi 5 database", async () => {
    const path = await database("CREATE TABLE other (id INTEGER);");
    expect(() => readStrapiAdminData(path)).toThrow(
      `${path} has no admin_roles table: is it a Strapi 5 database?`,
    );
  });

  it("reads only a SQLite file", () => {
    expect(() => readStrapiAdminData("mysql://u:p@host/db")).toThrow(
      "mysql://u:p@host/db is not a SQLite file; the admin roles are read from a Strapi project's SQLite database",
    );
  });
});

// strapi-php 5.56's getstarted database after registering the first admin and adding a
// "Content Writer" role through its admin API: Strapi's own Editor and Author, with their default
// permissions, and a custom role (admin tables and locales only).
const FIXTURE = fileURLToPath(new URL("./__fixtures__/strapi-php-admin.db", import.meta.url));

describe("readStrapiAdminRoles on a strapi-php database", () => {
  const categories: IrDocument = {
    version: 1,
    contentTypes: [
      {
        name: "Category",
        kind: "collection",
        options: { draftPublish: true, localized: true },
        fields: [
          { type: "string", name: "name", localized: true },
          { type: "dateTime", name: "datetime" },
          { type: "date", name: "date", localized: true },
        ],
      },
    ],
    components: [],
  };

  it("brings in Editor's grants, and only what Author and a custom role hold with no condition", () => {
    const imported = readStrapiAdminRoles(FIXTURE, categories, ["public", "authenticated"]);
    expect(imported.superAdmin).toBe(true);
    expect(imported.roles).toEqual([
      {
        name: "editor",
        description: "Editors can manage and publish contents including those of other users.",
        admin: true,
        grants: [
          { contentType: "Category", actions: ["create", "read", "update"] },
          { contentType: "File", actions: ["create", "read", "update", "delete"] },
        ],
      },
      {
        name: "author",
        description: "Authors can manage the content they have created.",
        admin: true,
        grants: [{ contentType: "File", actions: ["create"] }],
      },
      { name: "content-writer", description: "Writes articles", admin: true, grants: [] },
    ]);
    const messages = imported.gaps.map((g) => g.message);
    expect(messages).toContain(
      'admin role "author": plugin::content-manager.explorer.create, plugin::content-manager.explorer.read, plugin::content-manager.explorer.update on Category: only when admin::is-creator; a camis grant has no such condition, so not granted',
    );
    expect(messages).toContain(
      'admin role "content-writer": admin::webhooks.read: settings and plugin actions are not imported; in camis the Settings pages follow the role\'s grants on the User type',
    );
  });
});
