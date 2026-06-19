import { z } from "zod";
import { expression } from "@camis/expr";
import { fieldName, typeName } from "./identifiers";
import { ai } from "./ai";

export const FIELD_TYPES = [
  "string",
  "text",
  "richText",
  "email",
  "uid",
  "integer",
  "bigInteger",
  "float",
  "decimal",
  "boolean",
  "enumeration",
  "date",
  "time",
  "dateTime",
  "timestamp",
  "json",
  "media",
  "relation",
  "component",
  "dynamicZone",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const RELATION_KINDS = ["oneToOne", "oneToMany", "manyToOne", "manyToMany"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

const common = {
  name: fieldName,
  required: z.boolean().optional(),
  validate: expression.optional(),
  visibleWhen: expression.optional(),
  computed: expression.optional(),
};
const len = {
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
};
const bound = { min: z.number().optional(), max: z.number().optional() };

const textLike = (type: "string" | "text" | "richText" | "email") =>
  z.object({
    type: z.literal(type),
    ...common,
    unique: z.boolean().optional(),
    ...len,
    default: z.string().optional(),
    ...(type === "email" ? {} : { ai: ai.optional() }),
  });

const numeric = (type: "integer" | "bigInteger" | "float" | "decimal") =>
  z.object({
    type: z.literal(type),
    ...common,
    unique: z.boolean().optional(),
    ...bound,
    default: z.number().optional(),
  });

const temporal = (type: "date" | "time" | "dateTime" | "timestamp") =>
  z.object({ type: z.literal(type), ...common, default: z.string().optional() });

const uidField = z.object({
  type: z.literal("uid"),
  ...common,
  unique: z.boolean().optional(),
  ...len,
  targetField: fieldName.optional(),
  default: z.string().optional(),
});
const booleanField = z.object({
  type: z.literal("boolean"),
  ...common,
  default: z.boolean().optional(),
});
const enumerationField = z.object({
  type: z.literal("enumeration"),
  ...common,
  values: z.array(z.string()).min(1),
  default: z.string().optional(),
});
const jsonField = z.object({ type: z.literal("json"), ...common });
const mediaField = z.object({
  type: z.literal("media"),
  ...common,
  multiple: z.boolean().optional(),
  allowedTypes: z.array(z.enum(["image", "video", "audio", "file"])).optional(),
});

export const SCALAR_VARIANTS = [
  textLike("string"),
  textLike("text"),
  textLike("richText"),
  textLike("email"),
  uidField,
  numeric("integer"),
  numeric("bigInteger"),
  numeric("float"),
  numeric("decimal"),
  booleanField,
  enumerationField,
  temporal("date"),
  temporal("time"),
  temporal("dateTime"),
  temporal("timestamp"),
  jsonField,
  mediaField,
] as const;

export const perFieldRefine = (f: unknown, ctx: z.RefinementCtx) => {
  const anyF = f as Record<string, unknown>;
  if (
    typeof anyF.minLength === "number" &&
    typeof anyF.maxLength === "number" &&
    anyF.minLength > anyF.maxLength
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "minLength must be <= maxLength",
      params: { irCode: "invalid_min_max" },
      path: ["minLength"],
    });
  }
  if (typeof anyF.min === "number" && typeof anyF.max === "number" && anyF.min > anyF.max) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "min must be <= max",
      params: { irCode: "invalid_min_max" },
      path: ["min"],
    });
  }
  if (
    anyF.type === "enumeration" &&
    anyF.default !== undefined &&
    Array.isArray(anyF.values) &&
    !(anyF.values as string[]).includes(anyF.default as string)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "default must be one of values",
      params: { irCode: "enum_default_not_member" },
      path: ["default"],
    });
  }
};

const relationField = z.object({
  type: z.literal("relation"),
  ...common,
  relationKind: z.enum(RELATION_KINDS),
  target: typeName,
  inverse: fieldName.optional(),
});
const componentRefField = z.object({
  type: z.literal("component"),
  ...common,
  component: typeName,
  repeatable: z.boolean(),
});
const dynamicZoneField = z.object({
  type: z.literal("dynamicZone"),
  ...common,
  components: z.array(typeName).min(1),
});

const ALL_VARIANTS = [
  ...SCALAR_VARIANTS,
  relationField,
  componentRefField,
  dynamicZoneField,
] as const;
const COMPONENT_VARIANTS = [...SCALAR_VARIANTS, relationField, componentRefField] as const; // no dynamicZone (D6)

export const field = z.discriminatedUnion("type", [...ALL_VARIANTS]).superRefine(perFieldRefine);
export const componentField = z
  .discriminatedUnion("type", [...COMPONENT_VARIANTS])
  .superRefine(perFieldRefine);

export type Field = z.infer<typeof field>;
export type ComponentFieldT = z.infer<typeof componentField>;

export { typeName };
