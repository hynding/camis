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

export const importDocument = (
  files: { path: string; content: string }[],
): { document: Result<IrDocument>; gaps: CapabilityGapReport } => {
  const contentTypes: ContentType[] = [];
  const components: Component[] = [];
  const gaps: CapabilityGap[] = [];

  for (const file of files) {
    if (CONTENT_TYPE_RE.test(file.path)) {
      const r = irContentType(JSON.parse(file.content) as Record<string, unknown>);
      contentTypes.push(r.contentType);
      gaps.push(...r.gaps);
      continue;
    }
    const m = COMPONENT_RE.exec(file.path);
    if (m) {
      const r = irComponent(pascal(m[1]!), JSON.parse(file.content) as Record<string, unknown>);
      components.push(r.component);
      gaps.push(...r.gaps);
    }
  }

  const document = validate({ version: 1, contentTypes, components });
  return { document, gaps: { target: "strapi", gaps } };
};
