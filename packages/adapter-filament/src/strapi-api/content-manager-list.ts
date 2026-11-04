import type { ContentType, Field } from "@camis/ir-schema";

// Strapi's `_q` search: text fields match as a substring, number fields when the search is one.
const TEXT_SEARCHED = new Set(["string", "text", "richText", "uid", "email", "enumeration"]);
const NUMBER_SEARCHED = new Set(["integer", "bigInteger", "float", "decimal"]);
// The Content Manager's NON_SORTABLES (components and relations are not columns here).
const NOT_SORTED = new Set(["json", "media", "richText", "blocks"]);

/** A list column as Strapi's Content Manager offers it: searched and sorted where Strapi does. */
export const listedColumn = (field: Field, column: string, tableColumn: string): string => {
  const search = TEXT_SEARCHED.has(field.type)
    ? "->searchable()"
    : NUMBER_SEARCHED.has(field.type)
      ? `->searchable(query: fn (Builder $query, string $search): Builder => is_numeric($search) ? $query->where('${column}', $search) : $query->whereRaw('0 = 1'))`
      : "";
  const sort = NOT_SORTED.has(field.type) ? "" : "->sortable()";
  return `${tableColumn}${search}${sort}`;
};

export const searchesNumbers = (fields: readonly Field[]): boolean =>
  fields.some((f) => NUMBER_SEARCHED.has(f.type));

/** Strapi's default main field, which its list starts sorted by: the first string field, or id. */
export const mainFieldName = (ct: ContentType): string | undefined =>
  ct.fields.find((f) => f.type === "string")?.name;
