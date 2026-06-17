import { FIELD_TYPES, type CapabilityGap, type Field } from "@camis/ir-schema";
import { irName } from "./names";

export interface IrFieldResult {
  field?: Field;
  gap?: CapabilityGap;
  skip?: true;
}

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
    const target = irName(String(attr.target).split("::")[1]?.split(".")[0] ?? "");
    const field: Record<string, unknown> = {
      type: "relation",
      name,
      relationKind: attr.relation,
      target,
    };
    if (attr.inversedBy !== undefined) field.inverse = attr.inversedBy;
    return { field: field as Field };
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
  if (irType === "media" && attr.allowedTypes !== undefined) field.allowedTypes = attr.allowedTypes;
  return { field: field as Field };
};
