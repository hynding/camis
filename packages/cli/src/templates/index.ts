import { exampleTemplate } from "./example";
import type { ProjectTemplate } from "./project-template";
import { vanillaTemplate } from "./vanilla";

export type { ProjectTemplate } from "./project-template";
export { strapiDefaultRoles } from "./project-template";

const TEMPLATES = { vanilla: vanillaTemplate, example: exampleTemplate } as const;

export type ProjectTemplateName = keyof typeof TEMPLATES;
export const PROJECT_TEMPLATES = Object.keys(TEMPLATES) as ProjectTemplateName[];

export const isProjectTemplateName = (name: string): name is ProjectTemplateName =>
  Object.hasOwn(TEMPLATES, name);

export const projectTemplate = (name: ProjectTemplateName): ProjectTemplate => TEMPLATES[name];
