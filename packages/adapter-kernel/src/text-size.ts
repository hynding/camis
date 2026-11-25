import type { ComponentFieldT, Field, IrDocument, IrErrorLocation } from "@camis/ir-schema";

type AnyField = Field | ComponentFieldT;

/** How much a database's text column holds: the sizes a target that has several chooses among. */
export type TextTier = "small" | "medium" | "large";

/** The bytes each tier holds. */
export const TIER_BYTES: Record<TextTier, number> = {
  small: 65_535,
  medium: 16_777_215,
  large: 4_294_967_295,
};

/** The most bytes a character takes in the widest encoding a target stores text in (UTF-8). */
export const WORST_CASE_BYTES_PER_CHARACTER = 4;

const isText = (field: AnyField): field is AnyField & { type: "text" | "richText" } =>
  field.type === "text" || field.type === "richText";

const holds = (tier: TextTier, maxLength: number): boolean =>
  maxLength * WORST_CASE_BYTES_PER_CHARACTER <= TIER_BYTES[tier];

/**
 * The smallest tier that holds a text field's bound at the worst case, and the large one for a
 * text with no bound (as Strapi's longtext is) A bound
 * even the large tier cannot hold is listed by `textsBeyondTiers`; its column is the large tier.
 */
export const textTier = (field: AnyField): TextTier => {
  const maxLength = field.type === "text" ? field.maxLength : undefined;
  if (maxLength === undefined) return "large";
  return holds("small", maxLength) ? "small" : holds("medium", maxLength) ? "medium" : "large";
};

export interface LocatedText {
  location: IrErrorLocation;
  maxLength: number;
}

/** Every text whose bound not even the large tier holds, a component's included, located. */
export const textsBeyondTiers = (doc: IrDocument): LocatedText[] => {
  const located = (holder: IrErrorLocation, fields: readonly AnyField[]): LocatedText[] =>
    fields.flatMap((field) =>
      isText(field) && field.maxLength !== undefined && !holds("large", field.maxLength)
        ? [{ location: { ...holder, field: field.name }, maxLength: field.maxLength }]
        : [],
    );
  return [
    ...doc.contentTypes.flatMap((ct) => located({ contentType: ct.name }, ct.fields)),
    ...doc.components.flatMap((c) => located({ component: c.name }, c.fields)),
  ];
};
