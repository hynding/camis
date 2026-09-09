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
): { fields: Field[]; gaps: CapabilityGap[]; usesBuiltinUser: boolean } => {
  const fields: Field[] = [];
  const gaps: CapabilityGap[] = [];
  let usesBuiltinUser = false;
  for (const [name, attr] of Object.entries(attributes)) {
    const r = irField(name, asRecord(attr), location);
    if (r.skip) continue;
    if (r.field) fields.push(r.field);
    if (r.gap) gaps.push(r.gap);
    if (r.builtinUser) usesBuiltinUser = true;
  }
  return { fields, gaps, usesBuiltinUser };
};

export const irContentType = (
  schema: Record<string, unknown>,
): { contentType: ContentType; gaps: CapabilityGap[]; usesBuiltinUser: boolean } => {
  const info = asRecord(schema.info);
  const options = asRecord(schema.options);
  const name = irName(str(info.singularName));
  const { fields, gaps, usesBuiltinUser } = fieldsFromAttributes(asRecord(schema.attributes), {
    contentType: name,
  });
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
  return { contentType, gaps, usesBuiltinUser };
};

export const irComponent = (
  componentName: string,
  schema: Record<string, unknown>,
  group?: string,
): { component: Component; gaps: CapabilityGap[] } => {
  const { fields, gaps } = fieldsFromAttributes(asRecord(schema.attributes), {
    component: componentName,
  });
  const collection = str(schema.collectionName);
  const names: { collection?: string; group?: string } = {};
  if (collection !== "") names.collection = collection;
  if (group !== undefined && group !== "") names.group = group;
  const component: Component = {
    name: componentName,
    // dynamicZone fields are routed to gaps by irField (components disallow dynamicZone per
    // D6), so the fields array is safely narrowed to ComponentFieldT at runtime.
    fields: fields as ComponentFieldT[],
    ...(Object.keys(names).length > 0 ? { names } : {}),
  };
  return { component, gaps };
};
