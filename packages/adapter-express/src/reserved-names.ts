import { expandComponents } from "@camis/adapter-kernel";
import { reservedNameGaps, type ItemTable, type TargetName } from "@camis/ir-core";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import { isSupportedField } from "./fields";
import { snakeColumn } from "./names";
import { itemEntryKey } from "./schema";

/** Every content type's table ends in `createdAt` and `updatedAt`, as these columns. */
const TIMESTAMP_COLUMNS: ReadonlyMap<string, string> = new Map([
  ["created_at", "created_at"],
  ["updated_at", "updated_at"],
]);

/** A component's field is a column of the row holding it named by its joined path from there. */
const rowColumn = (path: readonly string[]): TargetName => {
  const column = path.map(snakeColumn).join("_");
  return { spelled: column, mapped: column };
};

/**
 * The item tables the schema emits, planned as it plans them: one per repeatable component a
 * content type holds (a repeatable nested in an item is left out, with a gap of its own). A row
 * keeps no timestamps, only its key to the entry.
 */
const itemTables = (doc: IrDocument): ItemTable[] =>
  doc.contentTypes.flatMap((ct) =>
    expandComponents(doc, ct).tables.map((t) => ({
      component: t.component.name,
      heldBy: [ct.name, ...t.path].join("."),
      kept: new Map([[itemEntryKey(ct), itemEntryKey(ct)]]),
    })),
  );

/**
 * An `error` gap for each column the schema would emit twice: a content type's field whose column
 * (its name in snake_case) is one of the table's timestamps, an embedded component's field's (its
 * path snake_cased and joined, `created` holding `at` being created_at) included, and an item's
 * field whose column on its item table's rows (its path from the item) is the key to its entry,
 * `<type>_id`. A built-in type is a plain table like any other, so it is checked too. An item
 * table has no timestamps.
 */
export const expressReservedNameGaps = (doc: IrDocument): CapabilityGap[] =>
  reservedNameGaps(
    doc,
    "the Express target",
    TIMESTAMP_COLUMNS,
    (field, holder) =>
      holder === "contentType" && isSupportedField(field.type)
        ? [{ spelled: field.name, mapped: snakeColumn(field.name) }]
        : [],
    {
      builtins: true,
      // A relation inside a component is left out on this target, with a gap of its own.
      columns: (path, field) => (field.type !== "relation" ? [rowColumn(path)] : []),
      items: itemTables(doc),
    },
  );
