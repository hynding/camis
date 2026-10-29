import { FIELD_TYPES, type CapabilityGap, type Field } from "@camis/ir-schema";
import { fromStrapiMediaKinds } from "@camis/strapi-schema";
import { fieldNameOf, irName } from "./names";

export interface IrFieldResult {
  field?: Field;
  gap?: CapabilityGap;
  skip?: true;
  builtinUser?: true;
}

const PLUGIN_USER_UID = "plugin::users-permissions.user";

const REVERSE_TYPE: Record<string, string> = {
  richtext: "richText",
  biginteger: "bigInteger",
  datetime: "dateTime",
};

const SCALAR_CONSTRAINTS = [
  "required",
  "unique",
  "minLength",
  "maxLength",
  "min",
  "max",
  "default",
  "targetField",
  "multiple",
] as const;

// Strapi keeps a private attribute out of every API answer; the IR field keeps it out too.
const privacy = (attr: Record<string, unknown>): { private?: true } =>
  attr.private === true ? { private: true } : {};

const isPattern = (source: string): boolean => {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
};

const componentName = (uid: unknown): string => irName(String(uid).split(".").slice(1).join("-"));

// A snake_case attribute keeps its name on the API: the IR field is camelCase and names it.
const named = (attribute: string): { name: string; names?: { api: string } } => {
  const name = fieldNameOf(attribute);
  return name === attribute ? { name } : { name, names: { api: attribute } };
};

export const irField = (
  attribute: string,
  attr: Record<string, unknown>,
  location: CapabilityGap["location"],
): IrFieldResult => {
  const strapiType = String(attr.type);
  const irType = REVERSE_TYPE[strapiType] ?? strapiType;
  const { name } = named(attribute);

  if (strapiType === "relation") {
    if (attr.mappedBy !== undefined) return { skip: true };
    if (String(attr.relation).startsWith("morph")) {
      return {
        gap: {
          feature: "morphRelation",
          location: { ...location, field: name },
          severity: "downgrade",
          message: `polymorphic relation "${attribute}" (${String(attr.relation)}) has no IR representation; skipped.`,
        },
      };
    }
    const rawTarget = String(attr.target);
    const builtinUser = rawTarget === PLUGIN_USER_UID;
    if (rawTarget.startsWith("plugin::") && !builtinUser) {
      return {
        gap: {
          feature: "pluginRelation",
          location: { ...location, field: name },
          severity: "downgrade",
          message: `relation "${attribute}" targets plugin type "${rawTarget}", which has no IR representation; skipped.`,
        },
      };
    }
    const target = builtinUser ? "User" : irName(rawTarget.split("::")[1]?.split(".")[0] ?? "");
    const field: Record<string, unknown> = {
      type: "relation",
      ...named(attribute),
      relationKind: attr.relation,
      target,
      ...privacy(attr),
    };
    let gap: CapabilityGap | undefined;
    if (attr.inversedBy !== undefined) {
      const inversedBy = String(attr.inversedBy);
      field.inverse = fieldNameOf(inversedBy);
      // The inverse side is not a field of its own in the IR, so it has nowhere to keep its key.
      if (field.inverse !== inversedBy) {
        gap = {
          feature: "inverseApiName",
          location: { ...location, field: name },
          severity: "downgrade",
          message: `the inverse of "${attribute}", "${inversedBy}", goes by "${String(field.inverse)}" on the API.`,
        };
      }
    }
    return {
      field: field as Field,
      ...(gap === undefined ? {} : { gap }),
      ...(builtinUser ? { builtinUser: true as const } : {}),
    };
  }
  if (strapiType === "component") {
    return {
      field: {
        type: "component",
        ...named(attribute),
        component: componentName(attr.component),
        repeatable: Boolean(attr.repeatable),
        ...privacy(attr),
      } as Field,
    };
  }
  if (strapiType === "dynamiczone") {
    const components = Array.isArray(attr.components) ? attr.components : [];
    return {
      field: {
        type: "dynamicZone",
        ...named(attribute),
        components: components.map(componentName),
        ...privacy(attr),
      } as Field,
    };
  }

  if (
    !(FIELD_TYPES as readonly string[]).includes(irType) ||
    irType === "relation" ||
    irType === "component" ||
    irType === "dynamicZone"
  ) {
    return {
      gap: {
        feature: strapiType,
        location: { ...location, field: name },
        severity: "downgrade",
        message: `Strapi attribute type "${strapiType}" on "${attribute}" is not representable; skipped.`,
      },
    };
  }

  const field: Record<string, unknown> = { type: irType, ...named(attribute), ...privacy(attr) };
  for (const k of SCALAR_CONSTRAINTS) if (attr[k] !== undefined) field[k] = attr[k];
  let gap: CapabilityGap | undefined;
  if (typeof attr.regex === "string" && attr.regex !== "") {
    if (isPattern(attr.regex)) field.pattern = attr.regex;
    else
      gap = {
        feature: "fieldPattern",
        location: { ...location, field: name },
        severity: "downgrade",
        message: `the regex of "${attribute}" is not a regular expression camis can read; the field is imported without it.`,
      };
  }
  if (typeof attr.targetField === "string") field.targetField = fieldNameOf(attr.targetField);
  if (irType === "enumeration") field.values = attr.enum;
  if (irType === "media" && Array.isArray(attr.allowedTypes)) {
    field.allowedTypes = fromStrapiMediaKinds(attr.allowedTypes);
  }
  return { field: field as Field, ...(gap === undefined ? {} : { gap }) };
};
