import { isAbsolute, resolve } from "node:path";
import { adminSourceLabel, readStrapiAdminRoles, readStrapiRoles } from "@camis/adapter-strapi";
import { validate } from "@camis/ir-core";
import type { IrDocument } from "@camis/ir-schema";
import { validateBundle, type Role, type RolesFile } from "@camis/permissions";
import type { Io } from "../io";
import { SUPER_ADMIN_ROLE, withSuperAdmin } from "../templates";
import { printGaps } from "./generate";
import { locStr } from "./validate";

export interface StrapiRolesSource {
  /** A `strapi export` archive, whose users-permissions roles become the IR's. */
  archive: string;
  /** The key it was exported with, when it is encrypted. */
  key?: string;
}

/**
 * The roles a Strapi project's export holds, as the IR's roles file, with the document they need
 * (the builtin user or file type a grant names); errors and gaps are printed.
 */
export const strapiRoles = async (
  io: Io,
  document: IrDocument,
  source: StrapiRolesSource,
): Promise<{ ok: true; document: IrDocument; roles: RolesFile } | { ok: false }> => {
  const path = isAbsolute(source.archive) ? source.archive : resolve(io.cwd, source.archive);
  let imported: Awaited<ReturnType<typeof readStrapiRoles>>;
  try {
    imported = await readStrapiRoles(path, document, source.key);
  } catch (e) {
    io.out(`✗ cannot read roles from ${source.archive}: ${(e as Error).message}`);
    return { ok: false };
  }
  const validated = validate(imported.document);
  if (!validated.ok) {
    for (const e of validated.errors) io.out(`✗ [${e.code}] ${locStr(e.location)} — ${e.message}`);
    return { ok: false };
  }
  const bundle = validateBundle({
    document: validated.value,
    roles: imported.roles.roles,
    ...(imported.roles.defaultRole !== undefined
      ? { defaultRole: imported.roles.defaultRole }
      : {}),
  });
  if (!bundle.ok) {
    for (const e of bundle.errors) io.out(`✗ [${e.code}] ${locStr(e.location)} — ${e.message}`);
    return { ok: false };
  }
  io.out(`✓ imported ${imported.roles.roles.length} roles from ${source.archive}`);
  printGaps(io, imported.gaps);
  return { ok: true, document: validated.value, roles: imported.roles };
};

/**
 * Strapi's admin roles, read from its database (a `strapi export` holds none), as the IR's admin
 * roles, with the document they need; errors and gaps are printed, a URL without its password. The
 * database is a SQLite file or a MySQL, MariaDB or PostgreSQL URL. A role keeps clear of the names
 * in `taken`, and of the super-admin, which stands for Strapi's Super Admin.
 */
export const strapiAdminRoles = async (
  io: Io,
  document: IrDocument,
  database: string,
  taken: readonly string[],
): Promise<{ ok: true; document: IrDocument; roles: Role[] } | { ok: false }> => {
  const path =
    database.includes("://") || isAbsolute(database) ? database : resolve(io.cwd, database);
  const label = adminSourceLabel(database);
  let imported: Awaited<ReturnType<typeof readStrapiAdminRoles>>;
  try {
    imported = await readStrapiAdminRoles(path, document, [...taken, SUPER_ADMIN_ROLE]);
  } catch (e) {
    io.out(`✗ cannot read admin roles from ${label}: ${(e as Error).message}`);
    return { ok: false };
  }
  io.out(`✓ imported ${imported.roles.length} admin roles from ${label}`);
  printGaps(io, imported.gaps);
  return { ok: true, document: imported.document, roles: imported.roles };
};

/**
 * The users' roles, then the super-admin (Strapi's Super Admin), then Strapi's other admin roles,
 * checked against the document.
 */
export const withAdminRoles = (
  io: Io,
  roles: RolesFile,
  adminRoles: readonly Role[],
  document: IrDocument,
): { ok: true; roles: RolesFile } | { ok: false } => {
  const withSuper = withSuperAdmin(roles, document);
  const merged: RolesFile = { ...withSuper, roles: [...withSuper.roles, ...adminRoles] };
  const bundle = validateBundle({
    document,
    roles: merged.roles,
    ...(merged.defaultRole !== undefined ? { defaultRole: merged.defaultRole } : {}),
  });
  if (!bundle.ok) {
    for (const e of bundle.errors) io.out(`✗ [${e.code}] ${locStr(e.location)} — ${e.message}`);
    return { ok: false };
  }
  return { ok: true, roles: merged };
};
