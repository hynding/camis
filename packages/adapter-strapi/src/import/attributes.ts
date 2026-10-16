import { FIELD_TYPES, type CapabilityGap, type Field } from "@camis/ir-schema";
import { fromStrapiMediaKinds } from "../media-kinds";
import { irName } from "./names";

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

export const irField = (
  name: string,
  attr: Record<string, unknown>,
  location: CapabilityGap["location"],
): IrFieldResult => {
  const strapiType = String(attr.type);
  const irType = REVERSE_TYPE[strapiType] ?? strapiType;

  if (strapiType === "relation") {
    if (attr.mappedBy !== undefined) return { skip: true };
    const rawTarget = String(attr.target);
    const builtinUser = rawTarget === PLUGIN_USER_UID;
    if (rawTarget.startsWith("plugin::") && !builtinUser) {
      return {
        gap: {
          feature: "pluginRelation",
          location: { ...location, field: name },
          severity: "downgrade",
          message: `relation "${name}" targets plugin type "${rawTarget}", which has no IR representation; skipped.`,
        },
      };
    }
    const target = builtinUser ? "User" : irName(rawTarget.split("::")[1]?.split(".")[0] ?? "");
    const field: Record<string, unknown> = {
      type: "relation",
      name,
      relationKind: attr.relation,
      target,
    };
    if (attr.inversedBy !== undefined) field.inverse = attr.inversedBy;
    return builtinUser ? { field: field as Field, builtinUser: true } : { field: field as Field };
  }
  if (strapiType === "component") {
    const compName = irName(String(attr.component).split(".").slice(1).join("-"));
    return {
      field: {
        type: "component",
        name,
        component: compName,
        repeatable: Boolean(attr.repeatable),
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
        message: `Strapi attribute type "${strapiType}" on "${name}" is not representable; skipped.`,
      },
    };
  }

  const field: Record<string, unknown> = { type: irType, name };
  for (const k of SCALAR_CONSTRAINTS) if (attr[k] !== undefined) field[k] = attr[k];
  if (irType === "enumeration") field.values = attr.enum;
  if (irType === "media" && Array.isArray(attr.allowedTypes)) {
    field.allowedTypes = fromStrapiMediaKinds(attr.allowedTypes);
  }
  return { field: field as Field };
};
