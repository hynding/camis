import type { Field } from "@camis/ir-schema";

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

  put(attr, "required", f.required);
  put(attr, "unique", f.unique);
  put(attr, "minLength", f.minLength);
  put(attr, "maxLength", f.maxLength);
  put(attr, "min", f.min);
  put(attr, "max", f.max);
  put(attr, "default", f.default);
  return attr;
};
