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
