import { reservedNameGaps, type TargetName } from "@camis/ir-core";
import type { CapabilityGap, Field, IrDocument } from "@camis/ir-schema";
import { STRAPI_RESERVED_NAMES, strapiAttributeNames } from "@camis/strapi-schema";
import { snakeColumn } from "./names";

/** `$table->timestamps()`, on every table a content type or a component item is stored in. */
const LARAVEL_TIMESTAMPS: ReadonlyMap<string, string> = new Map([
  ["created_at", "created_at"],
  ["updated_at", "updated_at"],
]);

const NO_COLUMN = new Set<Field["type"]>([
  "relation",
  "component",
  "dynamicZone",
  "polymorphicRelation",
  "polymorphicInverse",
]);

/** The column a field is stored in on its own row: a to-one relation's is its key. */
const columnNames = (field: Field): TargetName[] => {
  if (field.type === "relation") {
    const ownsKey = field.relationKind === "manyToOne" || field.relationKind === "oneToOne";
    const key = `${snakeColumn(field.name)}_id`;
    return ownsKey ? [{ spelled: key, mapped: key }] : [];
  }
  if (NO_COLUMN.has(field.type)) return [];
  return [{ spelled: field.name, mapped: snakeColumn(field.name) }];
};

/**
 * An `error` gap for each field whose column, or on the Strapi API style whose key on Strapi's wire
 * shape, is one the generated rows keep for themselves: Laravel's timestamps, and on the Strapi API
 * style the keys Strapi gives every entry (whose columns, document_id, published_at, locale and
 * created_by_id among them, the rows carry too).
 */
export const filamentReservedNameGaps = (
  doc: IrDocument,
  apiStyle: "laravel" | "strapi",
): CapabilityGap[] =>
  apiStyle === "strapi"
    ? reservedNameGaps(doc, "the Strapi API style", STRAPI_RESERVED_NAMES, (field) => [
        ...strapiAttributeNames(field),
        ...columnNames(field),
      ])
    : reservedNameGaps(doc, "the Laravel API style", LARAVEL_TIMESTAMPS, columnNames);
