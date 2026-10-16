import { strapiDefaultRoles, type ProjectTemplate } from "./project-template";

export const vanillaTemplate: ProjectTemplate = {
  document: { version: 1, contentTypes: [], components: [] },
  roles: strapiDefaultRoles(),
};
