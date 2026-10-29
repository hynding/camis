import { fieldApiName, type Field } from "@camis/ir-schema";
import { toStrapiMediaKinds } from "./media-kinds";
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

const PLUGIN_USER_UID = "plugin::users-permissions.user";

export const toAttribute = (
  field: Field,
  builtinUsers: ReadonlySet<string> = new Set(),
  componentUids: ReadonlyMap<string, string> = new Map(),
): Attribute => {
  const f = field as Field & Record<string, unknown>;
  const attr: Attribute = { type: TYPE_MAP[field.type] ?? field.type };
  const withPrivate = (a: Attribute): Attribute => {
    put(a, "private", field.private);
    return a;
  };

  if (field.type === "enumeration") {
    attr.enum = field.values;
    put(attr, "default", field.default);
    put(attr, "required", f.required);
    return withPrivate(attr);
  }

  if (field.type === "relation") {
    const targetSingular = kebab(field.target);
    attr.relation = field.relationKind;
    attr.target = builtinUsers.has(field.target)
      ? PLUGIN_USER_UID
      : `api::${targetSingular}.${targetSingular}`;
    put(attr, "inversedBy", field.inverse);
    return withPrivate(attr);
  }

  if (field.type === "dynamicZone") {
    attr.components = field.components.map((c) => componentUids.get(c) ?? `shared.${kebab(c)}`);
    return withPrivate(attr);
  }

  if (field.type === "component") {
    attr.component = componentUids.get(field.component) ?? `shared.${kebab(field.component)}`;
    attr.repeatable = field.repeatable;
    return withPrivate(attr);
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
  put(attr, "regex", f.pattern);
  if (field.type === "media" && field.allowedTypes !== undefined) {
    attr.allowedTypes = toStrapiMediaKinds(field.allowedTypes);
  }
  return withPrivate(attr);
};

export const toAttributes = (
  fields: Field[],
  builtinUsers: ReadonlySet<string> = new Set(),
  componentUids: ReadonlyMap<string, string> = new Map(),
): Record<string, Attribute> => {
  const out: Record<string, Attribute> = {};
  for (const field of fields)
    out[fieldApiName(field)] = toAttribute(field, builtinUsers, componentUids);
  return out;
};
