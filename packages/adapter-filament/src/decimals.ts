import type { StorageLayout } from "@camis/adapter-kernel";
import { DOUBLE_DIGITS, decimalsBeyond, digitsBeyond } from "@camis/ir-core";
import type { CapabilityGap, ComponentFieldT, Field, IrDocument } from "@camis/ir-schema";

/**
 * The significant digits PHP writes a float with when it becomes a string (its `precision`
 * setting, 14): PDO SQLite reads a decimal column's value as a float, and Laravel's decimal cast
 * makes a string of it, so a decimal of 15 digits read back through a float loses its last one.
 */
export const PHP_FLOAT_DIGITS = 14;

/**
 * Whether a decimal states more digits than a PHP float carries to its string: such a decimal is
 * text on SQLite, answered as a string and taken as exact digits, never through a float.
 */
export const beyondPhpFloat = (field: Field | ComponentFieldT): boolean =>
  digitsBeyond(field, PHP_FLOAT_DIGITS);

/**
 * What a decimal beyond a PHP float loses where the app compares or stores it. On the Laravel
 * storage layout its column is text on SQLite (see `decimalColumn`), so the Strapi API style's
 * filters and sorts compare it as text there; the Laravel API style neither filters nor sorts. Its
 * archives carry a decimal as a number, as Strapi's do, for Strapi to import. On Strapi's storage
 * layout the column is the one Strapi made, which SQLite keeps as a double.
 */
export const filamentDecimalGaps = (
  doc: IrDocument,
  apiStyle: "laravel" | "strapi",
  storage: StorageLayout,
): CapabilityGap[] =>
  storage === "laravel" && apiStyle === "laravel"
    ? []
    : decimalsBeyond(doc, PHP_FLOAT_DIGITS).map(({ location, digits }) => ({
        feature: "decimalPrecision",
        location,
        severity: "downgrade",
        message:
          storage === "strapi"
            ? `"${location.field}" keeps ${digits.precision} digits, but on Strapi's storage layout its column is Strapi's, which SQLite keeps as a double that PHP reads back as a float: on SQLite only ${PHP_FLOAT_DIGITS} significant digits are kept`
            : `"${location.field}" keeps its ${digits.precision} digits as text on SQLite, where a filter or a sort on it compares text, not numbers; a data-transfer archive carries it as a number, as Strapi's archives do, rounded to ${DOUBLE_DIGITS} significant digits`,
      }));
