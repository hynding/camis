import { z } from "zod";
import { fieldName, typeName } from "./identifiers";

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

const common = { name: fieldName, required: z.boolean().optional() };
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

export const perFieldRefine = (
  f: z.infer<(typeof SCALAR_VARIANTS)[number]>,
  ctx: z.RefinementCtx,
) => {
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
  if (f.type === "enumeration" && f.default !== undefined && !f.values.includes(f.default)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "default must be one of values",
      params: { irCode: "enum_default_not_member" },
      path: ["default"],
    });
  }
};

export const field = z.discriminatedUnion("type", [...SCALAR_VARIANTS]).superRefine(perFieldRefine);

export { typeName };
