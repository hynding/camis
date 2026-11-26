import {
  enforcedLength,
  isStringLike,
  withMarker,
  type GeneratedFile,
} from "@camis/adapter-kernel";
import type { ContentType, Field } from "@camis/ir-schema";
import type { Dialect } from "./dialect";
import { isSupportedField } from "./fields";
import { snakeColumn } from "./names";

const TEXT_LIKE = new Set<string>(["string", "email", "uid", "text", "richText"]);

/**
 * Each API-writable text-like field's length in characters, by its column (its key on the wire):
 * its bound, or on MySQL and PostgreSQL its column's length where an index caps the column below
 * it, so a value the column cannot hold is refused as invalid. SQLite's text holds any bound.
 */
export const maxLengths = (
  ct: ContentType,
  aiColumns: readonly string[] = [],
  dialect: Dialect = "sqlite",
): [string, number][] =>
  ct.fields.flatMap((field: Field): [string, number][] => {
    const bounded = field as Field & { maxLength?: number; unique?: boolean };
    // Only a string, an email or a uid is kept in a string column, which an index caps.
    const maxLength =
      dialect !== "sqlite" && isStringLike(bounded) ? enforcedLength(bounded) : bounded.maxLength;
    const column = snakeColumn(field.name);
    return TEXT_LIKE.has(field.type) &&
      isSupportedField(field.type) &&
      typeof maxLength === "number" &&
      !aiColumns.includes(column)
      ? [[column, maxLength]]
      : [];
  });

/** Whether any content type has a bounded field the API checks. */
export const hasMaxLengths = (cts: readonly ContentType[]): boolean =>
  cts.some((ct) => maxLengths(ct).length > 0);

// A JavaScript string's length counts UTF-16 code units, two for a character past the Basic
// Multilingual Plane; iterating it yields code points, which PHP's mb_strlen counts.
const LENGTHS = `/**
 * Characters as a maxLength counts them: Unicode code points, as PHP's mb_strlen and a VARCHAR's
 * length count them, not the UTF-16 code units a string's length counts.
 */
export const characterCount = (value: string): number => Array.from(value).length;

/** The error for the first field whose value is a string longer than its bound, or null. */
export const tooLong = (
  body: Record<string, unknown>,
  bounds: Record<string, number>,
): string | null => {
  for (const [field, maxLength] of Object.entries(bounds)) {
    const value = body[field];
    if (typeof value === "string" && characterCount(value) > maxLength)
      return \`\${field} must be at most \${maxLength} characters\`;
  }
  return null;
};
`;

export const lengthsFile = (): GeneratedFile => ({
  path: "src/lengths.ts",
  content: withMarker(LENGTHS),
});
