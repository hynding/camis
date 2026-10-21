import {
  fieldApiName,
  type CapabilityGap,
  type Component,
  type ComponentFieldT,
  type ContentType,
  type Field,
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
  // A schema.json may omit collectionName (Strapi then derives the table itself). Carrying it
  // through as "" would put an empty physical name in the IR, which is not a name at all — omit
  // the key instead, exactly as irComponent already does.
  const collection = str(schema.collectionName);
  const contentType: ContentType = {
    name,
    kind: schema.kind === "singleType" ? "single" : "collection",
    names: {
      display: str(info.displayName),
      plural: irName(str(info.pluralName)),
      ...(collection === "" ? {} : { collection }),
    },
    fields,
  };
  if (options.draftAndPublish) contentType.options = { draftPublish: true };
  if (asRecord(asRecord(schema.pluginOptions).i18n).localized === true) {
    contentType.options = { ...contentType.options, localized: true };
    const attributes = asRecord(schema.attributes);
    contentType.fields = fields.map((f) =>
      asRecord(asRecord(asRecord(attributes[fieldApiName(f)]).pluginOptions).i18n).localized ===
      false
        ? { ...f, localized: false }
        : f,
    );
  }
  return { contentType, gaps, usesBuiltinUser };
};

export const irComponent = (
  componentName: string,
  schema: Record<string, unknown>,
  group?: string,
): { component: Component; gaps: CapabilityGap[] } => {
  const { fields: all, gaps } = fieldsFromAttributes(asRecord(schema.attributes), {
    component: componentName,
  });
  // Strapi allows a dynamic zone only on a content type; one in a component has no IR form.
  const fields = all.filter((f) => {
    if (f.type !== "dynamicZone") return true;
    gaps.push({
      feature: "dynamiczone",
      location: { component: componentName, field: f.name },
      severity: "downgrade",
      message: `dynamic zone "${fieldApiName(f)}" inside component "${componentName}" is not representable; skipped.`,
    });
    return false;
  });
  const collection = str(schema.collectionName);
  const names: { collection?: string; group?: string } = {};
  if (collection !== "") names.collection = collection;
  if (group !== undefined && group !== "") names.group = group;
  const component: Component = {
    name: componentName,
    // dynamicZone fields were routed to gaps above (components disallow dynamicZone per D6), so
    // the fields array is safely narrowed to ComponentFieldT at runtime.
    fields: fields as ComponentFieldT[],
    ...(Object.keys(names).length > 0 ? { names } : {}),
  };
  return { component, gaps };
};
