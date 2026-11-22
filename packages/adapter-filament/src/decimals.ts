import type { StorageLayout } from "@camis/adapter-kernel";
import { decimalsBeyondDouble } from "@camis/ir-core";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";

/**
 * What a decimal beyond a double loses where the app compares or stores it. On the Laravel storage
 * layout its column is text on SQLite (see `decimalColumn`), so the Strapi API style's filters and
 * sorts compare it as text there; the Laravel API style neither filters nor sorts. On Strapi's
 * storage layout the column is the one Strapi made, which SQLite keeps as a double.
 */
export const filamentDecimalGaps = (
  doc: IrDocument,
  apiStyle: "laravel" | "strapi",
  storage: StorageLayout,
): CapabilityGap[] =>
  storage === "laravel" && apiStyle === "laravel"
    ? []
    : decimalsBeyondDouble(doc).map(({ location, digits }) => ({
        feature: "decimalPrecision",
        location,
        severity: "downgrade",
        message:
          storage === "strapi"
            ? `"${location.field}" keeps ${digits.precision} digits, but on Strapi's storage layout its column is Strapi's, which SQLite keeps as a double: on SQLite only 15 significant digits are kept`
            : `"${location.field}" keeps its ${digits.precision} digits as text on SQLite, where a filter or a sort on it compares text, not numbers`,
      }));
