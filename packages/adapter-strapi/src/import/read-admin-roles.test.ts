import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { readStrapiAdminData } from "./read-admin-roles";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

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
