import type { ContentType } from "@camis/ir-schema";
import { toAttributes } from "./attributes";
import { strapiNames } from "./names";

export const contentTypeSchema = (
  ct: ContentType,
  extraAttributes: Record<string, unknown> = {},
  builtinUsers: ReadonlySet<string> = new Set(),
  componentUids: ReadonlyMap<string, string> = new Map(),
): Record<string, unknown> => {
  const names = strapiNames(ct);
  const options: Record<string, unknown> = {};
  if (ct.options?.draftPublish) options.draftAndPublish = true;
  const localized = ct.options?.localized === true;
  const attributes = toAttributes(ct.fields, builtinUsers, componentUids);
  // Strapi's i18n plugin marks every non-relation attribute of a localized type; a relation is
  // localized by the type itself, each locale holding its own links.
  if (localized) {
    for (const f of ct.fields) {
      const attribute = attributes[f.name];
      if (attribute !== undefined && f.type !== "relation") {
        attribute.pluginOptions = { i18n: { localized: f.localized ?? true } };
      }
    }
  }
  return {
    kind: ct.kind === "single" ? "singleType" : "collectionType",
    collectionName: names.collectionName,
    info: {
      singularName: names.singularName,
      pluralName: names.pluralName,
      displayName: names.displayName,
    },
    options,
    pluginOptions: localized ? { i18n: { localized: true } } : {},
    attributes: { ...attributes, ...extraAttributes },
  };
};
