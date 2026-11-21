import { reservedNameGaps } from "@camis/ir-core";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import { isSupportedField } from "./fields";
import { snakeColumn } from "./names";

/** Every content type's table ends in `createdAt` and `updatedAt`, as these columns. */
const TIMESTAMP_COLUMNS: ReadonlyMap<string, string> = new Map([
  ["created_at", "created_at"],
  ["updated_at", "updated_at"],
]);

/**
 * An `error` gap for each field of a content type whose column (its name in snake_case) is one of
 * the table's timestamps. A component's fields are columns prefixed with the field that holds it,
 * or rows of a table of their own without timestamps, so they collide with none.
 */
export const expressReservedNameGaps = (doc: IrDocument): CapabilityGap[] =>
  reservedNameGaps(doc, "the Express target", TIMESTAMP_COLUMNS, (field, holder) =>
    holder === "contentType" && isSupportedField(field.type)
      ? [{ spelled: field.name, mapped: snakeColumn(field.name) }]
      : [],
  );
