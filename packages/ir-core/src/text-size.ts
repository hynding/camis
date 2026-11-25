import type {
  CapabilityGap,
  ComponentFieldT,
  Field,
  IrDocument,
  IrErrorLocation,
} from "@camis/ir-schema";

type AnyField = Field | ComponentFieldT;

/** The sizes of MySQL's text types; the other databases keep a text of any length in one type. */
export type TextColumnSize = "text" | "mediumText" | "longText";

/** What each size holds, in bytes. */
const CAPACITY_BYTES: Record<TextColumnSize, number> = {
  text: 65_535,
  mediumText: 16_777_215,
  longText: 4_294_967_295,
};

/** The most bytes a character takes in utf8mb4, which MySQL's column is measured against. */
const BYTES_PER_CHARACTER = 4;

const isText = (field: AnyField): field is AnyField & { type: "text" | "richText" } =>
  field.type === "text" || field.type === "richText";

const holds = (size: TextColumnSize, maxLength: number): boolean =>
  maxLength * BYTES_PER_CHARACTER <= CAPACITY_BYTES[size];

/**
 * The smallest MySQL text type that holds a text field's bound at the worst case, and the largest
 * for a text with no bound, as Strapi's longtext is. A bound even the largest cannot hold is
 * reported by `textsBeyondColumn`; its column is the largest.
 */
export const textColumnSize = (field: AnyField): TextColumnSize => {
  const maxLength = isText(field) ? field.maxLength : undefined;
  if (maxLength === undefined) return "longText";
  return holds("text", maxLength)
    ? "text"
    : holds("mediumText", maxLength)
      ? "mediumText"
      : "longText";
};

export interface LocatedText {
  location: IrErrorLocation;
  maxLength: number;
}

/** Every text whose bound no MySQL text type holds, a component's included, located. */
export const textsBeyondColumn = (doc: IrDocument): LocatedText[] => {
  const located = (holder: IrErrorLocation, fields: readonly AnyField[]): LocatedText[] =>
    fields.flatMap((field) =>
      isText(field) && field.maxLength !== undefined && !holds("longText", field.maxLength)
        ? [{ location: { ...holder, field: field.name }, maxLength: field.maxLength }]
        : [],
    );
  return [
    ...doc.contentTypes.flatMap((ct) => located({ contentType: ct.name }, ct.fields)),
    ...doc.components.flatMap((c) => located({ component: c.name }, c.fields)),
  ];
};

/** A gap for each text `textsBeyondColumn` lists, which `target`'s column cannot hold whole. */
export const textLengthGaps = (doc: IrDocument, target: string): CapabilityGap[] =>
  textsBeyondColumn(doc).map(({ location, maxLength }) => ({
    feature: "textLength",
    location,
    severity: "downgrade",
    message: `"${location.field}" is bounded at ${maxLength} characters, more than MySQL's largest text column (LONGTEXT, ${CAPACITY_BYTES.longText} bytes at up to ${BYTES_PER_CHARACTER} bytes a character) holds; ${target} makes it a LONGTEXT, which stores a value up to that size and refuses a larger one in strict mode, so MySQL never truncates it`,
  }));
