import {
  TIER_BYTES,
  UNIQUE_INDEX_LIMIT,
  WORST_CASE_BYTES_PER_CHARACTER,
  stringsBeyondColumns,
  type LocatedString,
} from "@camis/adapter-kernel";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";

const message = ({ location, maxLength, column }: LocatedString): string =>
  column.kind === "string"
    ? `"${location.field}" is declared unique and bounded at ${maxLength} characters, more than a unique index holds (${UNIQUE_INDEX_LIMIT}); its column settings size it to what a unique index holds, a varchar(${column.length}), and Strapi's validator checks the bound of ${maxLength}, so the database refuses a value longer than ${column.length} characters with an error rather than truncating`
    : `"${location.field}" is bounded at ${maxLength} characters, more than MySQL's largest text column (longtext, ${TIER_BYTES.large} bytes at up to ${WORST_CASE_BYTES_PER_CHARACTER} bytes a character) holds; its column settings make it a longtext, which MySQL refuses a larger value in rather than truncating`;

/** A string bound no column the attribute's column settings can give it holds, located. */
export const strapiStringLengthGaps = (doc: IrDocument): CapabilityGap[] =>
  stringsBeyondColumns(doc).map((located) => ({
    feature: "stringLength",
    location: located.location,
    severity: "downgrade",
    message: message(located),
  }));
