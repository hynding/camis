import {
  TIER_BYTES,
  WORST_CASE_BYTES_PER_CHARACTER,
  textsBeyondTiers,
} from "@camis/adapter-kernel";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";

/** A bound MySQL's largest text type (longtext) cannot hold: its column is a longtext, which refuses a larger value in strict mode rather than truncating it. */
export const expressTextLengthGaps = (doc: IrDocument): CapabilityGap[] =>
  textsBeyondTiers(doc).map(({ location, maxLength }) => ({
    feature: "textLength",
    location,
    severity: "downgrade",
    message: `"${location.field}" is bounded at ${maxLength} characters, more than MySQL's largest text type (longtext, ${TIER_BYTES.large} bytes at up to ${WORST_CASE_BYTES_PER_CHARACTER} bytes a character) holds; the Drizzle schema makes it a longtext, which MySQL refuses a larger value in rather than truncating`,
  }));
