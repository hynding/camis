import {
  INDEX_KEY_BYTES,
  INDEXED_STRING_LENGTH,
  STRING_LENGTH,
  TIER_BYTES,
  WORST_CASE_BYTES_PER_CHARACTER,
  isStringLike,
  stringsBeyondColumns,
  type LocatedString,
  type StorageLayout,
} from "@camis/adapter-kernel";
import type {
  CapabilityGap,
  ComponentFieldT,
  Field,
  IrDocument,
  IrErrorLocation,
} from "@camis/ir-schema";

const beyondColumn = ({ location, maxLength, column }: LocatedString): string =>
  column.kind === "string"
    ? `"${location.field}" is unique and bounded at ${maxLength} characters, more than a unique index holds on MySQL (${INDEX_KEY_BYTES} bytes, ${INDEXED_STRING_LENGTH} characters at up to ${WORST_CASE_BYTES_PER_CHARACTER} bytes a character); the migration makes it a VARCHAR(${column.length}) on every database, which MySQL and PostgreSQL refuse a longer value in rather than truncating`
    : `"${location.field}" is bounded at ${maxLength} characters, more than MySQL's largest text column (LONGTEXT, ${TIER_BYTES.large} bytes at up to ${WORST_CASE_BYTES_PER_CHARACTER} bytes a character) holds; the migration makes it a LONGTEXT, which MySQL refuses a larger value in rather than truncating`;

/** Every string bounded past what Strapi's own string column (a varchar(255)) holds, located. */
const stringsPastStrapiColumn = (
  doc: IrDocument,
): { location: IrErrorLocation; maxLength: number }[] => {
  const located = (holder: IrErrorLocation, fields: readonly (Field | ComponentFieldT)[]) =>
    fields.flatMap((field) =>
      isStringLike(field) && field.maxLength !== undefined && field.maxLength > STRING_LENGTH
        ? [{ location: { ...holder, field: field.name }, maxLength: field.maxLength }]
        : [],
    );
  return [
    ...doc.contentTypes.flatMap((ct) => located({ contentType: ct.name }, ct.fields)),
    ...doc.components.flatMap((c) => located({ component: c.name }, c.fields)),
  ];
};

/**
 * A string bound its column cannot hold. On the Laravel storage layout the migration makes the
 * column (see `stringColumn`); on Strapi's the column is the one Strapi made, a varchar(255) unless
 * the Strapi project gave the attribute column settings, which no migration of ours can know.
 */
export const filamentStringLengthGaps = (
  doc: IrDocument,
  storage: StorageLayout,
): CapabilityGap[] =>
  storage === "strapi"
    ? stringsPastStrapiColumn(doc).map(({ location, maxLength }) => ({
        feature: "stringLength",
        location,
        severity: "downgrade",
        message: `"${location.field}" is bounded at ${maxLength} characters; on Strapi's storage layout its column is the one Strapi made, a varchar(${STRING_LENGTH}) unless the Strapi project gave it column settings (as camis's Strapi target does), which MySQL and PostgreSQL refuse a longer value in`,
      }))
    : stringsBeyondColumns(doc).map((located) => ({
        feature: "stringLength",
        location: located.location,
        severity: "downgrade",
        message: beyondColumn(located),
      }));
