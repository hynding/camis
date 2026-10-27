import type { ContentType } from "@camis/ir-schema";
import { permissionKey } from "../permissions/keys";
import { kebab } from "./names";

export interface StrapiActionsInput {
  emitted: ContentType[];
  /** The builtin file type's name, whose grants are the upload plugin's actions. */
  fileType: string | undefined;
  /** The builtin user type's name, whose read is users-permissions' user actions. */
  userType: string | undefined;
}

export const contentTypeUid = (ct: ContentType): string =>
  `api::${kebab(ct.name)}.${kebab(ct.name)}`;

/**
 * The users-permissions actions each camis permission is in Strapi: a role's grants, as an
 * export writes them for Strapi's roles and the admin's Roles page shows them.
 */
export const strapiActions = (input: StrapiActionsInput): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const ct of input.emitted) {
    const api = `${contentTypeUid(ct)}.`;
    const single = ct.kind === "single";
    out[permissionKey(ct.name, "read")] = single ? [`${api}find`] : [`${api}find`, `${api}findOne`];
    out[permissionKey(ct.name, "create")] = [`${api}${single ? "update" : "create"}`];
    out[permissionKey(ct.name, "update")] = [`${api}update`];
    out[permissionKey(ct.name, "delete")] = [`${api}delete`];
  }
  if (input.fileType !== undefined) {
    const upload = "plugin::upload.content-api.";
    out[permissionKey(input.fileType, "read")] = [`${upload}find`, `${upload}findOne`];
    out[permissionKey(input.fileType, "create")] = [`${upload}upload`];
    out[permissionKey(input.fileType, "update")] = [`${upload}upload`];
    out[permissionKey(input.fileType, "delete")] = [`${upload}destroy`];
  }
  if (input.userType !== undefined) {
    const user = "plugin::users-permissions.user.";
    out[permissionKey(input.userType, "read")] = [`${user}find`, `${user}findOne`, `${user}count`];
  }
  return out;
};
