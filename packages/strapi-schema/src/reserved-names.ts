import { reservedNameGaps, snakeCase, type KeptNames, type TargetName } from "@camis/ir-core";
import {
  fieldApiName,
  inverseApiName,
  type CapabilityGap,
  type Field,
  type IrDocument,
} from "@camis/ir-schema";

/**
 * What camis refuses, of the names Strapi keeps, snake_cased as its Content-Type Builder compares an
 * attribute's name (the column it becomes), each to the key it goes by. The keys Strapi gives every
 * entry itself: an attribute of the same name is overwritten (`publishedAt`) or refused on write
 * (`updatedAt`); the `*_by_id` columns are the keys of `createdBy` and `updatedBy`. And Strapi's
 * discriminator keys: `__component` names a dynamic zone item's component beside the item's own
 * keys. Strapi's builder additionally refuses `status`, `meta` and `entry_id`, which are not keys of
 * an entry, so an attribute of that name reads and writes as it should, and camis lets them through.
 */
const STRAPI_KEYS: ReadonlyMap<string, string> = new Map([
  ["id", "id"],
  ["document_id", "documentId"],
  ["created_at", "createdAt"],
  ["updated_at", "updatedAt"],
  ["published_at", "publishedAt"],
  ["created_by", "createdBy"],
  ["updated_by", "updatedBy"],
  ["created_by_id", "createdBy"],
  ["updated_by_id", "updatedBy"],
  ["locale", "locale"],
  ["localizations", "localizations"],
  ["__component", "__component"],
  ["__content_type", "__contentType"],
]);

/** Strapi keeps names with these prefixes for its own columns (`strapi_stage`, `strapi_assignee`). */
const STRAPI_PREFIXES = ["strapi", "_strapi", "__strapi"] as const;

/** Every name camis refuses on a Strapi API: Strapi's own keys, and its prefix. */
export const STRAPI_RESERVED_NAMES: KeptNames = {
  get: (mapped) =>
    STRAPI_KEYS.get(mapped) ??
    (STRAPI_PREFIXES.some((prefix) => mapped.startsWith(prefix)) ? "strapi*" : undefined),
};

const named = (spelled: string): TargetName => ({ spelled, mapped: snakeCase(spelled) });

/** A field's attribute key, and its inverse's on the related type, as Strapi compares them. */
export const strapiAttributeNames = (field: Field): TargetName[] => {
  const inverse = field.type === "relation" ? inverseApiName(field) : undefined;
  return [
    named(fieldApiName(field)),
    ...(inverse === undefined ? [] : [{ ...named(inverse), inverse: true as const }]),
  ];
};

/** An `error` gap for each attribute, a component's included, named as a key Strapi keeps. */
export const strapiReservedNameGaps = (doc: IrDocument): CapabilityGap[] =>
  reservedNameGaps(doc, "Strapi", STRAPI_RESERVED_NAMES, strapiAttributeNames);
