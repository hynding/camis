import { reservedNameGaps, snakeCase, type TargetName } from "@camis/ir-core";
import {
  fieldApiName,
  inverseApiName,
  type CapabilityGap,
  type Field,
  type IrDocument,
} from "@camis/ir-schema";

/**
 * The keys Strapi gives every entry itself, snake_cased as its Content-Type Builder compares an
 * attribute's name (the column it becomes), each to the key it goes by. An attribute of the same
 * name is overwritten (`publishedAt`) or refused on write (`updatedAt`); the `*_by_id` columns are
 * the keys of `createdBy` and `updatedBy`.
 */
export const STRAPI_RESERVED_NAMES: ReadonlyMap<string, string> = new Map([
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
]);

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
