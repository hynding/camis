import {
  INDEX_KEY_BYTES,
  INDEXED_STRING_LENGTH,
  TIER_BYTES,
  WORST_CASE_BYTES_PER_CHARACTER,
  stringsBeyondColumns,
  type LocatedString,
} from "@camis/adapter-kernel";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";

const message = ({ location, maxLength, column }: LocatedString): string =>
  column.kind === "string"
    ? `"${location.field}" is unique and bounded at ${maxLength} characters, more than a unique index holds on MySQL (${INDEX_KEY_BYTES} bytes, ${INDEXED_STRING_LENGTH} characters at up to ${WORST_CASE_BYTES_PER_CHARACTER} bytes a character); its column settings make it a varchar(${column.length}), which MySQL and PostgreSQL refuse a longer value in rather than truncating`
    : `"${location.field}" is bounded at ${maxLength} characters, more than MySQL's largest text column (longtext, ${TIER_BYTES.large} bytes at up to ${WORST_CASE_BYTES_PER_CHARACTER} bytes a character) holds; its column settings make it a longtext, which MySQL refuses a larger value in rather than truncating`;

/** A string bound no column the attribute's column settings can give it holds, located. */
export const strapiStringLengthGaps = (doc: IrDocument): CapabilityGap[] =>
  stringsBeyondColumns(doc).map((located) => ({
    feature: "stringLength",
    location: located.location,
    severity: "downgrade",
    message: message(located),
  }));
