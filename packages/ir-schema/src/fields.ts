import { z } from "zod";
import { expression } from "@camis/expr";
import { apiName, fieldName, typeName } from "./identifiers";
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
  "blocks",
  "color",
  "media",
  "relation",
  "polymorphicRelation",
  "polymorphicInverse",
  "component",
  "dynamicZone",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const RELATION_KINDS = ["oneToOne", "oneToMany", "manyToOne", "manyToMany"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

const common = {
  name: fieldName,
  /** The key the field goes by on the API when it is not its name: an imported project's own. */
  names: z.object({ api: apiName.optional() }).optional(),
  required: z.boolean().optional(),
  validate: expression.optional(),
  visibleWhen: expression.optional(),
  computed: expression.optional(),
  /** On a localized content type: whether the value varies per locale (it does by default). */
  localized: z.boolean().optional(),
  /** Kept out of every API answer, filter, sort and populate; still written and still exported. */
  private: z.boolean().optional(),
  /**
   * The editor the source project chose for the field (a plugin's input over this type), kept so
   * the field exports back as it came; a target that has no such editor shows its own.
   */
  editor: z
    .object({ name: z.string().min(1), options: z.record(z.string(), z.unknown()).optional() })
    .optional(),
};
/** A regular expression's source (no delimiters or flags) the whole value must match. */
const pattern = z
  .string()
  .refine(
    (source) => {
      try {
        new RegExp(source);
        return true;
      } catch {
        return false;
      }
    },
    {
      message: "pattern must be a valid regular expression",
      params: { irCode: "invalid_pattern" },
    },
  )
  .optional();
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
    pattern,
    default: z.string().optional(),
    ...(type === "email" ? {} : { ai: ai.optional() }),
  });

/**
 * A decimal's digits in all (`precision`) and after the point (`scale`), stated together; without
 * them each target keeps its own default. Bounded in `perFieldRefine` by MySQL's DECIMAL, the
 * narrowest database every target runs on.
 */
const decimalDigits = { precision: z.number().optional(), scale: z.number().optional() };

const numeric = <T extends "integer" | "bigInteger" | "float" | "decimal">(type: T) =>
  z.object({
    type: z.literal(type),
    ...common,
    unique: z.boolean().optional(),
    ...bound,
    default: z.number().optional(),
  });
const decimalField = numeric("decimal").extend(decimalDigits);

const temporal = (type: "date" | "time" | "dateTime" | "timestamp") =>
  z.object({ type: z.literal(type), ...common, default: z.string().optional() });

const uidField = z.object({
  type: z.literal("uid"),
  ...common,
  unique: z.boolean().optional(),
  ...len,
  pattern,
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
/**
 * Rich text kept as a document tree rather than markup: a list of blocks (paragraph, heading,
 * quote, code, list, image), each holding inline text and link nodes, in the node shape Strapi's
 * blocks editor stores.
 */
const blocksField = z.object({ type: z.literal("blocks"), ...common });
/** A color as text (`#rrggbb`), edited with a color picker. */
const colorField = z.object({
  type: z.literal("color"),
  ...common,
  pattern,
  default: z.string().optional(),
});
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
  decimalField,
  booleanField,
  enumerationField,
  temporal("date"),
  temporal("time"),
  temporal("dateTime"),
  temporal("timestamp"),
  jsonField,
  blocksField,
  colorField,
  mediaField,
] as const;

/**
 * MySQL's DECIMAL takes at most 65 digits, 30 of them after the point; PostgreSQL's NUMERIC takes
 * 1000 and SQLite declares any, so MySQL's bounds are what every supported database takes.
 */
const MAX_DECIMAL_PRECISION = 65;
const MAX_DECIMAL_SCALE = 30;

const wholeIn = (value: unknown, min: number, max: number): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** A finite number's digits before and after the point, as its shortest decimal form writes them. */
const pointDigits = (value: number): { whole: number; fraction: number } => {
  const [mantissa = "0", exponent = "0"] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "").length;
  const beforePoint = Number(exponent) + 1;
  return {
    whole: Math.abs(value) < 1 ? 0 : beforePoint,
    fraction: Math.max(digits - beforePoint, 0),
  };
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

type DecimalKey = "precision" | "scale" | "default" | "min" | "max";

const refineDecimalDigits = (f: Record<string, unknown>, ctx: z.RefinementCtx): void => {
  const issue = (key: DecimalKey, message: string): void =>
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message,
      params: { irCode: "invalid_decimal_digits" },
      path: [key],
    });
  const { precision, scale } = f;
  if (precision === undefined && scale === undefined) return;
  if (precision === undefined) return issue("precision", "scale must be stated with a precision");
  if (scale === undefined) return issue("scale", "precision must be stated with a scale");
  if (!wholeIn(precision, 1, MAX_DECIMAL_PRECISION))
    return issue(
      "precision",
      `precision must be a whole number from 1 to ${MAX_DECIMAL_PRECISION}`,
    );
  if (!wholeIn(scale, 0, MAX_DECIMAL_SCALE))
    return issue("scale", `scale must be a whole number from 0 to ${MAX_DECIMAL_SCALE}`);
  const p = precision as number;
  const s = scale as number;
  if (s > p) return issue("scale", "scale must be <= precision");
  // A value the column cannot hold fails the migration's default or every write it bounds.
  for (const key of ["default", "min", "max"] as const) {
    const value = f[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const { whole, fraction } = pointDigits(value);
    if (whole > p - s)
      issue(
        key,
        `${key} has ${plural(whole, "digit")} before the point; precision ${p} with scale ${s} keeps ${p - s}`,
      );
    else if (key === "default" && fraction > s)
      issue(key, `default has ${plural(fraction, "digit")} after the point; scale ${s} keeps ${s}`);
  }
};

export const perFieldRefine = (f: unknown, ctx: z.RefinementCtx) => {
  const anyF = f as Record<string, unknown>;
  if (anyF.type === "decimal") refineDecimalDigits(anyF, ctx);
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
  /** The key the inverse goes by on the API when it is not its name: an imported project's own. */
  inverseNames: z.object({ api: apiName }).optional(),
});
/** Links to entries of any content type, each link naming its entry's type. */
const polymorphicRelationField = z.object({
  type: z.literal("polymorphicRelation"),
  ...common,
  many: z.boolean(),
});
/** The entries of `target` whose polymorphic relation `via` links here: read, never written. */
const polymorphicInverseField = z.object({
  type: z.literal("polymorphicInverse"),
  ...common,
  target: typeName,
  via: fieldName,
  /** The key `via` goes by on the target's API when it is not its name: an imported project's own. */
  viaNames: z.object({ api: apiName }).optional(),
  many: z.boolean(),
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
  polymorphicRelationField,
  polymorphicInverseField,
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

/** The key a field goes by on the API: the one it names, else its own name. */
export const fieldApiName = <
  F extends { name: string; names?: { api?: string | undefined } | undefined },
>(
  f: F,
): string => f.names?.api ?? f.name;

/** The key a relation's inverse goes by on the target's API: the one it names, else its name. */
export const inverseApiName = (f: {
  inverse?: string | undefined;
  inverseNames?: { api: string } | undefined;
}): string | undefined => f.inverseNames?.api ?? f.inverse;
