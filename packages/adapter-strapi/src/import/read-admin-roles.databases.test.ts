import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IrDocument } from "@camis/ir-schema";
import { describe, expect, it } from "vitest";
import { readStrapiAdminData, readStrapiAdminRoles } from "./read-admin-roles";

// strapi-php's getstarted on each database, set up as the SQLite fixture was (the first admin,
// then a "Content Writer" role): the import is the same whichever database a project runs on.
// CI's admin-roles-databases job points these at its MySQL and PostgreSQL services; without the
// variables they are skipped, as unit tests reach no server.
const fixture = (name: string): string =>
  fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));

const TABLES = ["admin_permissions_role_lnk", "admin_permissions", "admin_roles", "i18n_locale"];

const loadMysql = async (url: string): Promise<void> => {
  const { createConnection } = await import("mysql2/promise");
  const connection = await createConnection({ uri: url, multipleStatements: true });
  await connection.query(`DROP TABLE IF EXISTS ${TABLES.join(", ")}`);
  await connection.query(readFileSync(fixture("strapi-php-admin.mysql.sql"), "utf8"));
  await connection.end();
};

const loadPostgres = async (url: string): Promise<void> => {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(`DROP TABLE IF EXISTS ${TABLES.join(", ")}`);
  await client.query(readFileSync(fixture("strapi-php-admin.pgsql.sql"), "utf8"));
  await client.end();
};

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
const TAKEN = ["public", "authenticated"];

const servers = [
  { dialect: "MySQL", url: process.env.CAMIS_TEST_MYSQL_URL, load: loadMysql },
  { dialect: "PostgreSQL", url: process.env.CAMIS_TEST_POSTGRES_URL, load: loadPostgres },
];

describe.each(servers)("admin roles from $dialect", ({ url, load }) => {
  it.runIf(url !== undefined)(
    "imports what the SQLite database of the same project gives",
    async () => {
      const source = url!;
      await load(source);
      const sqlite = await readStrapiAdminRoles(fixture("strapi-php-admin.db"), categories, TAKEN);
      const imported = await readStrapiAdminRoles(source, categories, TAKEN);
      expect(imported.superAdmin).toBe(true);
      expect(imported.roles).toEqual(sqlite.roles);
      expect(imported.gaps).toEqual(sqlite.gaps);
    },
  );

  it.runIf(url !== undefined)("reads JSON columns parsed and ids as numbers", async () => {
    const data = await readStrapiAdminData(url!);
    expect(data.roles.map((r) => [r.id, r.code.replace(/-\w+$/, "")])).toEqual([
      [1, "strapi-super"],
      [2, "strapi"],
      [3, "strapi"],
      [4, "content-writer"],
    ]);
    expect(data.permissions.find((p) => p.role === 3)?.conditions).toEqual(["admin::is-creator"]);
    expect(data.locales).toEqual(["en"]);
  });
});
