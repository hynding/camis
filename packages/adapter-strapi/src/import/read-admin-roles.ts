import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { IrDocument } from "@camis/ir-schema";
import {
  importStrapiAdminRoles,
  type ImportedAdminRoles,
  type StrapiAdminData,
} from "./admin-roles";

// Vite (Vitest) does not know node:sqlite as a builtin and strips its prefix, so it is required.
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

type Row = Record<string, unknown>;

/** The few reads the importer makes, on whichever database a Strapi project runs. */
interface AdminTables {
  has: (table: string) => Promise<boolean>;
  all: (sql: string) => Promise<Row[]>;
  close: () => Promise<void>;
}

const MYSQL = /^(?:mysql|mariadb):\/\//;
const POSTGRES = /^postgres(?:ql)?:\/\//;

/** The source as it may be shown: a database URL without its password. */
export const adminSourceLabel = (source: string): string =>
  MYSQL.test(source) || POSTGRES.test(source)
    ? source.replace(/^([a-z]+:\/\/[^:/@]*):[^/]*@/, "$1:***@")
    : source;

const sqliteTables = (path: string): AdminTables => {
  if (!existsSync(path)) {
    throw new Error(
      `${path} is neither a SQLite file nor a mysql:// or postgres:// URL; the admin roles are read from a Strapi project's database`,
    );
  }
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    has: (table) =>
      Promise.resolve(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
          undefined,
      ),
    all: (sql) => Promise.resolve(db.prepare(sql).all() as Row[]),
    close: () => Promise.resolve(db.close()),
  };
};

const mysqlTables = async (url: string): Promise<AdminTables> => {
  const { createConnection } = await import("mysql2/promise");
  // mariadb:// is MySQL's protocol under another name.
  const connection = await createConnection({ uri: url.replace(/^mariadb:/, "mysql:") });
  const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
    (await connection.query(sql, params))[0] as Row[];
  return {
    has: async (table) =>
      (
        await rows(
          "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
          [table],
        )
      ).length > 0,
    all: (sql) => rows(sql),
    close: () => connection.end(),
  };
};

const postgresTables = async (url: string): Promise<AdminTables> => {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return {
    has: async (table) =>
      (await client.query<Row>("SELECT to_regclass($1) IS NOT NULL AS found", [table])).rows[0]
        ?.found === true,
    all: async (sql) => (await client.query<Row>(sql)).rows,
    close: () => client.end(),
  };
};

const openAdminTables = (source: string): Promise<AdminTables> =>
  MYSQL.test(source)
    ? mysqlTables(source)
    : POSTGRES.test(source)
      ? postgresTables(source)
      : Promise.resolve(sqliteTables(source));

// SQLite and MariaDB hand JSON columns back as text, MySQL 8 and PostgreSQL parsed.
const json = (value: unknown): unknown => {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const id = (value: unknown): number | string => (typeof value === "number" ? value : String(value));

/**
 * The admin roles and permissions a Strapi project's database holds (a SQLite file, or a MySQL,
 * MariaDB or PostgreSQL URL): `strapi export` leaves admin data out of its archive, so the
 * database is the only declarative source of them.
 */
export const readStrapiAdminData = async (source: string): Promise<StrapiAdminData> => {
  const db = await openAdminTables(source);
  try {
    if (!(await db.has("admin_roles"))) {
      throw new Error(
        `${adminSourceLabel(source)} has no admin_roles table: is it a Strapi 5 database?`,
      );
    }
    const roles = (
      await db.all("SELECT id, name, code, description FROM admin_roles ORDER BY id")
    ).map((row) => ({
      id: id(row.id),
      name: text(row.name),
      code: text(row.code),
      description: typeof row.description === "string" ? row.description : null,
    }));
    const permissions =
      (await db.has("admin_permissions")) && (await db.has("admin_permissions_role_lnk"))
        ? (
            await db.all(
              `SELECT l.role_id AS role, p.action AS action, p.subject AS subject,
                      p.properties AS properties, p.conditions AS conditions
                 FROM admin_permissions p
                 JOIN admin_permissions_role_lnk l ON l.permission_id = p.id
                ORDER BY l.role_id, l.permission_ord, p.id`,
            )
          ).map((row) => ({
            role: id(row.role),
            action: text(row.action),
            subject: typeof row.subject === "string" ? row.subject : null,
            properties: json(row.properties),
            conditions: json(row.conditions),
          }))
        : [];
    const locales = (await db.has("i18n_locale"))
      ? (await db.all("SELECT code FROM i18n_locale ORDER BY id")).map((row) => text(row.code))
      : [];
    return { roles, permissions, locales };
  } finally {
    await db.close();
  }
};

/** The IR's admin roles from a Strapi project's database. */
export const readStrapiAdminRoles = async (
  source: string,
  document: IrDocument,
  taken: readonly string[] = [],
): Promise<ImportedAdminRoles> =>
  importStrapiAdminRoles(await readStrapiAdminData(source), document, taken);
