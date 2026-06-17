import type {
  CapabilityGap,
  Component,
  ComponentFieldT,
  ContentType,
  Field,
} from "@camis/ir-schema";
import { irField } from "./attributes";
import { irName } from "./names";

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const fieldsFromAttributes = (
  attributes: Record<string, unknown>,
  location: CapabilityGap["location"],
): { fields: Field[]; gaps: CapabilityGap[] } => {
  const fields: Field[] = [];
  const gaps: CapabilityGap[] = [];
  for (const [name, attr] of Object.entries(attributes)) {
    const r = irField(name, asRecord(attr), location);
    if (r.skip) continue;
    if (r.field) fields.push(r.field);
    if (r.gap) gaps.push(r.gap);
  }
  return { fields, gaps };
};

export const irContentType = (
  schema: Record<string, unknown>,
): { contentType: ContentType; gaps: CapabilityGap[] } => {
  const info = asRecord(schema.info);
  const options = asRecord(schema.options);
  const name = irName(str(info.singularName));
  const { fields, gaps } = fieldsFromAttributes(asRecord(schema.attributes), { contentType: name });
  const contentType: ContentType = {
    name,
    kind: schema.kind === "singleType" ? "single" : "collection",
    names: {
      display: str(info.displayName),
      plural: irName(str(info.pluralName)),
      collection: str(schema.collectionName),
    },
    fields,
  };
  if (options.draftAndPublish) contentType.options = { draftPublish: true };
  return { contentType, gaps };
};

export const irComponent = (
  componentName: string,
  schema: Record<string, unknown>,
): { component: Component; gaps: CapabilityGap[] } => {
  const { fields, gaps } = fieldsFromAttributes(asRecord(schema.attributes), {
    component: componentName,
  });
  // dynamicZone fields are routed to gaps by irField (components disallow dynamicZone per D6),
  // so the fields array is safely narrowed to ComponentFieldT at runtime.
  return { component: { name: componentName, fields: fields as ComponentFieldT[] }, gaps };
};
