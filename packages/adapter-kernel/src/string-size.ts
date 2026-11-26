import type { ComponentFieldT, Field, IrDocument, IrErrorLocation } from "@camis/ir-schema";
import {
  WORST_CASE_BYTES_PER_CHARACTER,
  largeTierHolds,
  tierHolding,
  type TextTier,
} from "./text-size";

type AnyField = Field | ComponentFieldT;

/**
 * The length every target gives a string column without a bound, and the longest a bounded,
 * non-unique string's own column gets: a string column's whole declared length counts toward the
 * bytes a MySQL row may take (65,535), so such a column is never wider than an unbounded one.
 */
export const STRING_LENGTH = 255;

/**
 * The bytes an index entry holds on the narrowest database: a PostgreSQL btree entry, 2,704 bytes
 * (a third of an 8 KiB page); MySQL's InnoDB index key holds 3,072.
 */
export const INDEX_KEY_BYTES = 2704;

/** The bytes of a PostgreSQL btree entry its headers take: the index tuple's 8, the value's 4. */
export const INDEX_ENTRY_HEADER_BYTES = 12;

/**
 * The longest unique string column an index entry holds at the worst case: PostgreSQL 16 takes 673
 * distinct four-byte characters and refuses 674 ("index row size 2712 exceeds btree version 4
 * maximum 2704").
 */
export const INDEXED_STRING_LENGTH = Math.floor(
  (INDEX_KEY_BYTES - INDEX_ENTRY_HEADER_BYTES) / WORST_CASE_BYTES_PER_CHARACTER,
);

/** Why a unique string's column is capped, for a target's gap message. */
export const UNIQUE_INDEX_LIMIT = `a PostgreSQL btree entry holds ${INDEX_KEY_BYTES} bytes with ${INDEX_ENTRY_HEADER_BYTES} of headers, ${INDEXED_STRING_LENGTH} characters at up to ${WORST_CASE_BYTES_PER_CHARACTER} bytes a character`;

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

/**
 * The length a write path checks: the field's bound, or its column's length where the column is
 * capped below it, so a value the column cannot hold is refused as invalid rather than failing in
 * the database.
 */
export const enforcedLength = (field: StringBound): number | undefined => {
  if (field.maxLength === undefined) return undefined;
  const column = stringColumn(field);
  return column.kind === "string" && column.length !== undefined
    ? Math.min(field.maxLength, column.length)
    : field.maxLength;
};

/** Whether a field's column is a text column: a text, a rich text, or a string bounded past one. */
export const holdsTextColumn = (field: AnyField): boolean =>
  field.type === "text" ||
  field.type === "richText" ||
  (isStringLike(field) && stringColumn(field).kind === "text");

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
