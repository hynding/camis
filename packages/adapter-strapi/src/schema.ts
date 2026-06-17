import type { ContentType } from "@camis/ir-schema";
import { toAttributes } from "./attributes";
import { strapiNames } from "./names";

export const contentTypeSchema = (ct: ContentType): Record<string, unknown> => {
  const names = strapiNames(ct);
  const options: Record<string, unknown> = {};
  if (ct.options?.draftPublish) options.draftAndPublish = true;
  return {
    kind: ct.kind === "single" ? "singleType" : "collectionType",
    collectionName: names.collectionName,
    info: {
      singularName: names.singularName,
      pluralName: names.pluralName,
      displayName: names.displayName,
    },
    options,
    pluginOptions: {},
    attributes: toAttributes(ct.fields),
  };
};
