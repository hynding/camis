import { reservedNameGaps, type TargetName } from "@camis/ir-core";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import { isSupportedField } from "./fields";
import { snakeColumn } from "./names";

/** Every content type's table ends in `createdAt` and `updatedAt`, as these columns. */
const TIMESTAMP_COLUMNS: ReadonlyMap<string, string> = new Map([
  ["created_at", "created_at"],
  ["updated_at", "updated_at"],
]);

/** An embedded component's field is a column of the entry's table named by its joined path. */
const embeddedColumn = (path: readonly string[]): TargetName => {
  const column = path.map(snakeColumn).join("_");
  return { spelled: column, mapped: column };
};

/**
 * An `error` gap for each field of a content type whose column (its name in snake_case) is one of
 * the table's timestamps, an embedded component's field's (its path snake_cased and joined,
 * `created` holding `at` being created_at) included. A built-in type is a plain table like any
 * other, so it is checked too. A repeatable component's fields are rows of a table of their own
 * without timestamps, so they collide with none.
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
      columns: (path, field) => (field.type !== "relation" ? [embeddedColumn(path)] : []),
    },
  );
