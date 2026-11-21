import { reservedNameGaps, type ReservedNameOptions, type TargetName } from "@camis/ir-core";
import type { CapabilityGap, Field, IrDocument } from "@camis/ir-schema";
import { STRAPI_RESERVED_NAMES, strapiAttributeNames } from "@camis/strapi-schema";
import { snakeColumn } from "./names";

type ApiStyle = "laravel" | "strapi";

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

const ownsKey = (field: Extract<Field, { type: "relation" }>): boolean =>
  field.relationKind === "manyToOne" || field.relationKind === "oneToOne";

const column = (name: string): TargetName => ({ spelled: name, mapped: name });

/** The column a field is stored in on its own row: a to-one relation's is its key. */
const columnNames = (field: Field): TargetName[] => {
  if (field.type === "relation")
    return ownsKey(field) ? [column(`${snakeColumn(field.name)}_id`)] : [];
  if (NO_COLUMN.has(field.type)) return [];
  return [{ spelled: field.name, mapped: snakeColumn(field.name) }];
};

/**
 * The column an embedded component's field is stored in on the row holding it, named by its path
 * snake_cased and joined (`created` holding `at` is created_at). Only the Strapi API style keeps a
 * relation inside a component, a to-one one by a key column, and keeps a media library, whose
 * files a media field links rather than holds.
 */
const embeddedColumnNames =
  (apiStyle: ApiStyle) =>
  (path: readonly string[], field: Field): TargetName[] => {
    const prefix = path.map(snakeColumn).join("_");
    if (field.type === "relation")
      return apiStyle === "strapi" && ownsKey(field) ? [column(`${prefix}_id`)] : [];
    if (NO_COLUMN.has(field.type) || (apiStyle === "strapi" && field.type === "media")) return [];
    return [column(prefix)];
  };

/**
 * An `error` gap for each field whose column, or on the Strapi API style whose key on Strapi's wire
 * shape, is one the generated rows keep for themselves: Laravel's timestamps, and on the Strapi API
 * style the keys Strapi gives every entry (whose columns, document_id, published_at, locale and
 * created_by_id among them, the rows carry too). On the Laravel storage layout an embedded
 * component's fields are columns of the row holding it, an item's included; the Strapi storage
 * layout keeps a component in a table of its own, as Strapi does.
 */
export const filamentReservedNameGaps = (
  doc: IrDocument,
  apiStyle: ApiStyle,
  storage: ApiStyle,
): CapabilityGap[] => {
  const options: ReservedNameOptions =
    storage === "laravel" ? { embedded: embeddedColumnNames(apiStyle) } : {};
  return apiStyle === "strapi"
    ? reservedNameGaps(
        doc,
        "the Strapi API style",
        STRAPI_RESERVED_NAMES,
        (field) => [...strapiAttributeNames(field), ...columnNames(field)],
        options,
      )
    : reservedNameGaps(doc, "the Laravel API style", LARAVEL_TIMESTAMPS, columnNames, options);
};
