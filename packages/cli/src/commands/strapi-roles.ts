import { isAbsolute, resolve } from "node:path";
import { readStrapiRoles } from "@camis/adapter-strapi";
import { validate } from "@camis/ir-core";
import type { IrDocument } from "@camis/ir-schema";
import { validateBundle, type RolesFile } from "@camis/permissions";
import type { Io } from "../io";
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
