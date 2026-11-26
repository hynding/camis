import {
  TIER_BYTES,
  UNIQUE_INDEX_LIMIT,
  WORST_CASE_BYTES_PER_CHARACTER,
  stringsBeyondColumns,
  type LocatedString,
} from "@camis/adapter-kernel";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import type { Dialect } from "./dialect";

const message = ({ location, maxLength, column }: LocatedString): string =>
  column.kind === "string"
    ? `"${location.field}" is unique and bounded at ${maxLength} characters, more than a unique index holds (${UNIQUE_INDEX_LIMIT}); the Drizzle schema makes it a varchar(${column.length}), and the API refuses a value longer than ${column.length} characters`
    : `"${location.field}" is bounded at ${maxLength} characters, more than MySQL's largest text type (longtext, ${TIER_BYTES.large} bytes at up to ${WORST_CASE_BYTES_PER_CHARACTER} bytes a character) holds; the Drizzle schema makes it a longtext, which MySQL refuses a larger value in rather than truncating`;

/**
 * A string bound no column the Drizzle schema can give it holds, located: on MySQL a unique string
 * past what an index holds and a string past the largest text type; on PostgreSQL, whose text holds
 * any bound, a unique string only. SQLite's text holds any bound, indexed or not.
 */
export const expressStringLengthGaps = (doc: IrDocument, dialect: Dialect): CapabilityGap[] =>
  stringsBeyondColumns(doc)
    .filter(
      (located) => dialect === "mysql" || (dialect === "pgsql" && located.column.kind === "string"),
    )
    .map((located) => ({
      feature: "stringLength",
      location: located.location,
      severity: "downgrade",
      message: message(located),
    }));
