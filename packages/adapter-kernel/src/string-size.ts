import type { ComponentFieldT, Field, IrDocument, IrErrorLocation } from "@camis/ir-schema";
import {
  WORST_CASE_BYTES_PER_CHARACTER,
  largeTierHolds,
  tierHolding,
  type TextTier,
} from "./text-size";

type AnyField = Field | ComponentFieldT;

/**
 * The length every target gives a string column without a bound, and the longest a bounded
 * string's own column gets: a string column's whole length counts toward the bytes a row may take
 * (65,535 on MySQL), so a table holds as many bounded string columns as unbounded ones.
 */
export const STRING_LENGTH = 255;

/** The bytes an index key holds on the narrowest database (MySQL's InnoDB). */
export const INDEX_KEY_BYTES = 3072;

/** The longest unique string column an index key holds at the worst case. */
export const INDEXED_STRING_LENGTH = INDEX_KEY_BYTES / WORST_CASE_BYTES_PER_CHARACTER;

/**
 * The column a string-like field gets: its own string column, of the target's default length
 * without a bound, or a text column of the tier that holds its bound.
 */
export type StringColumn = { kind: "string"; length?: number } | { kind: "text"; tier: TextTier };

/** What sizes a string's column: its bound in characters, and whether an index keeps it unique. */
export interface StringBound {
  maxLength?: number | undefined;
  unique?: boolean | undefined;
}

/** A field kept in a string column (a string, an email or a uid), with its bound. */
export const isStringLike = (field: AnyField): field is AnyField & StringBound =>
  field.type === "string" || field.type === "email" || field.type === "uid";

/**
 * A string's column. A bound past `STRING_LENGTH` is a text column of the tier that holds it,
 * except for a unique string, which a text column cannot index whole: its column is a string column
 * no longer than an index key holds (`stringsBeyondColumns` lists a bound past that).
 */
export const stringColumn = (field: StringBound): StringColumn => {
  const { maxLength } = field;
  if (maxLength === undefined) return { kind: "string" };
  if (maxLength <= STRING_LENGTH) return { kind: "string", length: maxLength };
  if (field.unique === true)
    return { kind: "string", length: Math.min(maxLength, INDEXED_STRING_LENGTH) };
  return { kind: "text", tier: tierHolding(maxLength) };
};

const holdsBound = (column: StringColumn, maxLength: number): boolean =>
  column.kind === "string"
    ? (column.length ?? STRING_LENGTH) >= maxLength
    : largeTierHolds(maxLength);

export interface LocatedString {
  location: IrErrorLocation;
  maxLength: number;
  column: StringColumn;
}

/** Every string whose column cannot hold its bound, a component's included, located. */
export const stringsBeyondColumns = (doc: IrDocument): LocatedString[] => {
  const located = (holder: IrErrorLocation, fields: readonly AnyField[]): LocatedString[] =>
    fields.flatMap((field) => {
      if (!isStringLike(field) || field.maxLength === undefined) return [];
      const column = stringColumn(field);
      return holdsBound(column, field.maxLength)
        ? []
        : [{ location: { ...holder, field: field.name }, maxLength: field.maxLength, column }];
    });
  return [
    ...doc.contentTypes.flatMap((ct) => located({ contentType: ct.name }, ct.fields)),
    ...doc.components.flatMap((c) => located({ component: c.name }, c.fields)),
  ];
};
