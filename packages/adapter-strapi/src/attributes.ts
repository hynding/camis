import type { Field } from "@camis/ir-schema";
import { kebab } from "./names";

type Attribute = Record<string, unknown>;

const TYPE_MAP: Record<string, string> = {
  richText: "richtext",
  bigInteger: "biginteger",
  dateTime: "datetime",
  dynamicZone: "dynamiczone",
};

// Copy a key onto the attribute only when defined (no `undefined` keys → stable JSON).
const put = (attr: Attribute, key: string, value: unknown): void => {
  if (value !== undefined) attr[key] = value;
};

export const toAttribute = (field: Field): Attribute => {
  const f = field as Field & Record<string, unknown>;
  const attr: Attribute = { type: TYPE_MAP[field.type] ?? field.type };

  if (field.type === "enumeration") {
    attr.enum = field.values;
    put(attr, "default", field.default);
    put(attr, "required", f.required);
    return attr;
  }

  if (field.type === "relation") {
    const targetSingular = kebab(field.target);
    attr.relation = field.relationKind;
    attr.target = `api::${targetSingular}.${targetSingular}`;
    put(attr, "inversedBy", field.inverse);
    return attr;
  }

  if (field.type === "component") {
    attr.component = `shared.${kebab(field.component)}`;
    attr.repeatable = field.repeatable;
    return attr;
  }

  put(attr, "required", f.required);
  put(attr, "unique", f.unique);
  put(attr, "minLength", f.minLength);
  put(attr, "maxLength", f.maxLength);
  put(attr, "min", f.min);
  put(attr, "max", f.max);
  put(attr, "default", f.default);
  put(attr, "targetField", f.targetField);
  put(attr, "multiple", f.multiple);
  put(attr, "allowedTypes", f.allowedTypes);
  return attr;
};

export const toAttributes = (fields: Field[]): Record<string, Attribute> => {
  const out: Record<string, Attribute> = {};
  for (const field of fields) {
    if (field.type === "dynamicZone") continue; // deferred; generate emits a capability-gap
    out[field.name] = toAttribute(field);
  }
  return out;
};
