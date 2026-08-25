import { validate } from "@camis/ir-core";
import type {
  CapabilityGap,
  CapabilityGapReport,
  Component,
  ContentType,
  IrDocument,
  Result,
} from "@camis/ir-schema";
import { irComponent, irContentType } from "./schema";

const CONTENT_TYPE_RE = /\/content-types\/[^/]+\/schema\.json$/;
const COMPONENT_RE = /(?:^|\/)src\/components\/[^/]+\/([^/]+)\.json$/;

const pascal = (kebab: string): string =>
  kebab
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

// The IR stand-in for the target's native user model (Strapi: plugin::users-permissions.user).
// Synthesized only when plugin-user relations are imported and the project has no own User type.
export const BUILTIN_USER: ContentType = {
  name: "User",
  kind: "collection",
  builtin: "user",
  fields: [
    { type: "string", name: "username", required: true, unique: true },
    { type: "email", name: "email", required: true },
  ],
};

export const importDocument = (
  files: { path: string; content: string }[],
): { document: Result<IrDocument>; gaps: CapabilityGapReport } => {
  const contentTypes: ContentType[] = [];
  const components: Component[] = [];
  const gaps: CapabilityGap[] = [];
  let usesBuiltinUser = false;

  for (const file of files) {
    if (CONTENT_TYPE_RE.test(file.path)) {
      const r = irContentType(JSON.parse(file.content) as Record<string, unknown>);
      contentTypes.push(r.contentType);
      gaps.push(...r.gaps);
      if (r.usesBuiltinUser) usesBuiltinUser = true;
      continue;
    }
    const m = COMPONENT_RE.exec(file.path);
    if (m) {
      const r = irComponent(pascal(m[1]!), JSON.parse(file.content) as Record<string, unknown>);
      components.push(r.component);
      gaps.push(...r.gaps);
    }
  }

  if (usesBuiltinUser && !contentTypes.some((ct) => ct.name === BUILTIN_USER.name)) {
    contentTypes.push(BUILTIN_USER);
  }

  const document = validate({ version: 1, contentTypes, components });
  return { document, gaps: { target: "strapi", gaps } };
};
