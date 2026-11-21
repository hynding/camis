import { expandComponents } from "@camis/adapter-kernel";
import {
  reservedNameGaps,
  type ItemTable,
  type ReservedNameOptions,
  type TargetName,
} from "@camis/ir-core";
import type { CapabilityGap, Field, IrDocument } from "@camis/ir-schema";
import { STRAPI_RESERVED_NAMES, strapiAttributeNames } from "@camis/strapi-schema";
import { childTableEmit, ITEM_POSITION_COLUMN, type ChildTableEmit } from "./components";
import { snakeColumn } from "./names";

type ApiStyle = "laravel" | "strapi";

/** `$table->timestamps()`, on every table a content type or a component item is stored in. */
const LARAVEL_TIMESTAMPS: ReadonlyMap<string, string> = new Map([
  ["created_at", "created_at"],
  ["updated_at", "updated_at"],
]);

/** The same timestamps, which the Strapi API style answers as Strapi's own keys. */
const STRAPI_TIMESTAMPS: ReadonlyMap<string, string> = new Map([
  ["created_at", "createdAt"],
  ["updated_at", "updatedAt"],
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
 * The column a component's field is stored in on the row holding it, named by its path from that
 * row snake_cased and joined (`created` holding `at` is created_at). Only the Strapi API style
 * keeps a relation inside a component, a to-one one by a key column. With a media library
 * (`linksMedia`) a media field links the library's files rather than holding a path column.
 */
const rowColumnNames =
  (apiStyle: ApiStyle, linksMedia: boolean) =>
  (path: readonly string[], field: Field): TargetName[] => {
    const prefix = path.map(snakeColumn).join("_");
    if (field.type === "relation")
      return apiStyle === "strapi" && ownsKey(field) ? [column(`${prefix}_id`)] : [];
    if (NO_COLUMN.has(field.type) || (linksMedia && field.type === "media")) return [];
    return [column(prefix)];
  };

/**
 * The item tables the generator emits on the Laravel storage layout, planned as it plans them: a
 * repeatable component's, nested ones included on the Strapi API style, and on that style a
 * dynamic zone member's (the Laravel API style keeps a zone in one column of the entry's). A row
 * keeps its timestamps, its key to the row holding it and, a zone member's, its place.
 */
const itemTables = (doc: IrDocument, apiStyle: ApiStyle, linksMedia: boolean): ItemTable[] => {
  const deep = apiStyle === "strapi";
  const timestamps = deep ? STRAPI_TIMESTAMPS : LARAVEL_TIMESTAMPS;
  const rows = (child: ChildTableEmit, holder: string): ItemTable[] => [
    {
      component: child.component.name,
      heldBy: [holder, ...child.path].join("."),
      kept: new Map([
        ...timestamps,
        [child.fk, child.fk],
        ...(child.ordered === true ? [[ITEM_POSITION_COLUMN, ITEM_POSITION_COLUMN] as const] : []),
      ]),
    },
    ...child.children.flatMap((c) => rows(c, child.component.name)),
  ];
  return doc.contentTypes
    .filter((ct) => ct.builtin === undefined)
    .flatMap((ct) => {
      const expansion = expandComponents(
        doc,
        ct,
        deep ? { componentRelations: true, nestedTables: true } : {},
      );
      const context = deep ? { doc } : undefined;
      const zoneMembers = deep
        ? expansion.zones.flatMap((z) =>
            z.members.map((m) => ({
              ...childTableEmit(ct, m.table, linksMedia, context),
              ordered: true,
            })),
          )
        : [];
      return [
        ...expansion.tables.map((t) => childTableEmit(ct, t, linksMedia, context)),
        ...zoneMembers,
      ].flatMap((child) => rows(child, ct.name));
    });
};

/**
 * An `error` gap for each field whose column, or on the Strapi API style whose key on Strapi's wire
 * shape, is one the generated rows keep for themselves: Laravel's timestamps, and on the Strapi API
 * style the names Strapi keeps: the keys it gives every entry (whose columns, document_id,
 * published_at, locale and created_by_id among them, the rows carry too), its discriminator keys
 * and its strapi prefix. On the Laravel storage layout an embedded component's fields are columns
 * of the row holding it, and an item's fields columns of its item table's rows, which carry the
 * timestamps too; the Strapi storage layout keeps a component in a table of its own, as Strapi
 * does. `linksMedia` says whether the project keeps a media library (`mediaPlan`).
 */
export const filamentReservedNameGaps = (
  doc: IrDocument,
  apiStyle: ApiStyle,
  storage: ApiStyle,
  linksMedia: boolean,
): CapabilityGap[] => {
  const options: ReservedNameOptions =
    storage === "laravel"
      ? {
          columns: rowColumnNames(apiStyle, linksMedia),
          items: itemTables(doc, apiStyle, linksMedia),
        }
      : {};
  return apiStyle === "strapi"
    ? reservedNameGaps(
        doc,
        "the Strapi API style",
        STRAPI_RESERVED_NAMES,
        // A component's columns are its rows' (`items`); its keys are Strapi's wherever it is.
        (field, holder) =>
          holder === "contentType"
            ? [...strapiAttributeNames(field), ...columnNames(field)]
            : strapiAttributeNames(field),
        options,
      )
    : reservedNameGaps(
        doc,
        "the Laravel API style",
        LARAVEL_TIMESTAMPS,
        (field, holder) => (holder === "contentType" ? columnNames(field) : []),
        options,
      );
};
