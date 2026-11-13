import { FIELD_TYPES, type CapabilityGap, type Field } from "@camis/ir-schema";
import { COLOR_PICKER_UID, fromStrapiMediaKinds } from "@camis/strapi-schema";
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

/**
 * A morphTo relation links entries of any type; a morphOne or morphMany reads the entries of its
 * target whose morphTo relation (its morphBy) links here.
 */
const polymorphic = (
  attribute: string,
  attr: Record<string, unknown>,
  location: CapabilityGap["location"],
): IrFieldResult => {
  const relation = String(attr.relation);
  const name = fieldNameOf(attribute);
  if (relation.startsWith("morphTo")) {
    return {
      field: {
        type: "polymorphicRelation",
        ...named(attribute),
        many: relation === "morphToMany",
        ...privacy(attr),
      },
    };
  }
  const rawTarget = String(attr.target);
  if (rawTarget.startsWith("plugin::")) {
    return {
      gap: {
        feature: "pluginRelation",
        location: { ...location, field: name },
        severity: "downgrade",
        message: `relation "${attribute}" targets plugin type "${rawTarget}", which has no IR representation; skipped.`,
      },
    };
  }
  if (typeof attr.morphBy !== "string" || attr.morphBy === "") {
    return {
      gap: {
        feature: "morphRelation",
        location: { ...location, field: name },
        severity: "downgrade",
        message: `polymorphic relation "${attribute}" (${relation}) names no morphBy field; skipped.`,
      },
    };
  }
  const via = fieldNameOf(attr.morphBy);
  return {
    field: {
      type: "polymorphicInverse",
      ...named(attribute),
      target: irName(rawTarget.split("::")[1]?.split(".")[0] ?? ""),
      via,
      ...(via === attr.morphBy ? {} : { viaNames: { api: attr.morphBy } }),
      many: relation === "morphMany",
      ...privacy(attr),
    },
  };
};

export interface FieldImportOptions {
  /**
   * The Strapi type each custom field stores, by its uid: Strapi keeps it in the plugin's code
   * (`strapi.customFields.register`), not in schema.json, so the project names it.
   */
  customFields?: Readonly<Record<string, string>>;
}

/** A custom field as the type it stores, remembering its plugin's input as the field's editor. */
const customField = (
  attribute: string,
  attr: Record<string, unknown>,
  location: CapabilityGap["location"],
  storedAs: string,
): IrFieldResult => {
  const { customField: uid, options, ...rest } = attr;
  const r = irField(attribute, { ...rest, type: storedAs }, location);
  if (r.field === undefined) return r;
  const editor = {
    name: String(uid),
    ...(options !== null && typeof options === "object"
      ? { options: options as Record<string, unknown> }
      : {}),
  };
  return { ...r, field: { ...r.field, editor } };
};

export const irField = (
  attribute: string,
  attr: Record<string, unknown>,
  location: CapabilityGap["location"],
  opts: FieldImportOptions = {},
): IrFieldResult => {
  const strapiType = String(attr.type);
  const { name } = named(attribute);
  if (strapiType === "customField" && attr.customField !== COLOR_PICKER_UID) {
    const uid = String(attr.customField);
    const storedAs = opts.customFields?.[uid];
    if (storedAs !== undefined) return customField(attribute, attr, location, storedAs);
    return {
      gap: {
        feature: "customField",
        location: { ...location, field: name },
        severity: "downgrade",
        message: `custom field "${attribute}" (${uid}) is not representable; name the type it stores with --custom-field ${uid}=<type>; skipped.`,
      },
    };
  }
  const irType = strapiType === "customField" ? "color" : (REVERSE_TYPE[strapiType] ?? strapiType);

  if (strapiType === "relation") {
    if (attr.mappedBy !== undefined) return { skip: true };
    if (String(attr.relation).startsWith("morph")) return polymorphic(attribute, attr, location);
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
      ...(attr.required === true ? { required: true } : {}),
      ...privacy(attr),
    };
    if (attr.inversedBy !== undefined) {
      const inversedBy = String(attr.inversedBy);
      field.inverse = fieldNameOf(inversedBy);
      // The inverse side is not a field of its own in the IR, so the relation keeps its API key.
      if (field.inverse !== inversedBy) field.inverseNames = { api: inversedBy };
    }
    return {
      field: field as Field,
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
