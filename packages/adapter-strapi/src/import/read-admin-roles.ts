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
 * The admin roles and permissions a Strapi project's SQLite database holds: `strapi export`
 * leaves admin data out of its archive, so the database is the only declarative source of them.
 */
export const readStrapiAdminData = (databasePath: string): StrapiAdminData => {
  if (!existsSync(databasePath)) {
    throw new Error(
      `${databasePath} is not a SQLite file; the admin roles are read from a Strapi project's SQLite database`,
    );
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const has = (table: string): boolean =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
      undefined;
    if (!has("admin_roles")) {
      throw new Error(`${databasePath} has no admin_roles table: is it a Strapi 5 database?`);
    }
    const roles = db
      .prepare("SELECT id, name, code, description FROM admin_roles ORDER BY id")
      .all()
      .map((row) => ({
        id: id(row.id),
        name: text(row.name),
        code: text(row.code),
        description: typeof row.description === "string" ? row.description : null,
      }));
    const permissions =
      has("admin_permissions") && has("admin_permissions_role_lnk")
        ? db
            .prepare(
              `SELECT l.role_id AS role, p.action AS action, p.subject AS subject,
                      p.properties AS properties, p.conditions AS conditions
                 FROM admin_permissions p
                 JOIN admin_permissions_role_lnk l ON l.permission_id = p.id
                ORDER BY l.role_id, l.permission_ord, p.id`,
            )
            .all()
            .map((row) => ({
              role: id(row.role),
              action: text(row.action),
              subject: typeof row.subject === "string" ? row.subject : null,
              properties: json(row.properties),
              conditions: json(row.conditions),
            }))
        : [];
    const locales = has("i18n_locale")
      ? db
          .prepare("SELECT code FROM i18n_locale ORDER BY id")
          .all()
          .map((row) => text(row.code))
      : [];
    return { roles, permissions, locales };
  } finally {
    db.close();
  }
};

/** The IR's admin roles from a Strapi project's SQLite database. */
export const readStrapiAdminRoles = (
  databasePath: string,
  document: IrDocument,
  taken: readonly string[] = [],
): ImportedAdminRoles => importStrapiAdminRoles(readStrapiAdminData(databasePath), document, taken);
