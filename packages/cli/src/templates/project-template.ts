import type { IrDocument } from "@camis/ir-schema";
import type { Grant, RolesFile } from "@camis/permissions";

export interface ProjectTemplate {
  document: IrDocument;
  roles: RolesFile;
}

/**
 * Strapi's users-permissions plugin ships these two roles and assigns `authenticated` on
 * registration; a new project starts with the same pair so the generated targets behave alike.
 */
export const strapiDefaultRoles = (publicGrants: Grant[] = []): RolesFile => ({
  defaultRole: "authenticated",
  roles: [
    {
      name: "public",
      description: "Default role given to unauthenticated users.",
      grants: publicGrants,
    },
    {
      name: "authenticated",
      description: "Default role given to authenticated users.",
      grants: [],
    },
  ],
});

export const SUPER_ADMIN_ROLE = "super-admin";

/**
 * Strapi's Super Admin: signs in to the admin and may do everything. Its admin roles live
 * outside the users-permissions export, so a new or migrated project gets this one; a project
 * that already flags a role admin keeps its own.
 */
export const withSuperAdmin = (roles: RolesFile, document: IrDocument): RolesFile => {
  if (roles.roles.some((r) => r.admin === true || r.name === SUPER_ADMIN_ROLE)) return roles;
  const grants: Grant[] = document.contentTypes.map((ct) => ({
    contentType: ct.name,
    actions:
      ct.options?.draftPublish === true
        ? ["create", "read", "update", "delete", "publish"]
        : ["create", "read", "update", "delete"],
  }));
  return {
    ...roles,
    roles: [
      ...roles.roles,
      {
        name: SUPER_ADMIN_ROLE,
        description: "Signs in to the admin and may do everything, as Strapi's Super Admin.",
        admin: true,
        grants,
      },
    ],
  };
};
