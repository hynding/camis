import { DOUBLE_DIGITS, decimalsBeyondDouble } from "@camis/ir-core";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";

/**
 * Strapi 5 reads and writes a decimal as a JavaScript number on every database (its database
 * layer's NumberField converts each value with Number() and lodash's toNumber, and its REST API
 * validates one as z.number()), so a decimal stating more digits than a double keeps is rounded
 * whatever its column keeps.
 */
export const strapiDecimalGaps = (doc: IrDocument): CapabilityGap[] =>
  decimalsBeyondDouble(doc).map(({ location, digits }) => ({
    feature: "decimalPrecision",
    location,
    severity: "downgrade",
    message: `"${location.field}" keeps ${digits.precision} digits, but Strapi reads and writes a decimal as a JavaScript number, which keeps ${DOUBLE_DIGITS} significant digits: its values are rounded to them`,
  }));
