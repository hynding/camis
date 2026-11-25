import {
  TIER_BYTES,
  WORST_CASE_BYTES_PER_CHARACTER,
  textsBeyondTiers,
  type StorageLayout,
} from "@camis/adapter-kernel";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";

/**
 * A bound MySQL's largest text column (LONGTEXT) cannot hold. Laravel's migration still makes the
 * column LONGTEXT, which refuses a larger value in strict mode rather than truncating it. On Strapi's storage layout
 * the column is Strapi's, made by no migration of ours.
 */
export const filamentTextLengthGaps = (doc: IrDocument, storage: StorageLayout): CapabilityGap[] =>
  storage === "strapi"
    ? []
    : textsBeyondTiers(doc).map(({ location, maxLength }) => ({
        feature: "textLength",
        location,
        severity: "downgrade",
        message: `"${location.field}" is bounded at ${maxLength} characters, more than MySQL's largest text column (LONGTEXT, ${TIER_BYTES.large} bytes at up to ${WORST_CASE_BYTES_PER_CHARACTER} bytes a character) holds; the migration makes it a LONGTEXT, which MySQL refuses a larger value in rather than truncating`,
      }));
