import { createHash } from "node:crypto";

/** PostgreSQL keeps 63 characters of an identifier and MySQL refuses one over 64. */
const MAX_IDENTIFIER = 63;

/**
 * The name Laravel gives a key or index (`table_columns_suffix`) when it fits; otherwise a name
 * that does, cut short and ended with a hash of the whole so two long ones stay apart. Null means
 * Laravel's own name fits, so the migration need not name it.
 */
export const indexName = (
  table: string,
  columns: readonly string[],
  suffix: "foreign" | "unique",
): string | null => {
  const name = `${table}_${columns.join("_")}_${suffix}`.replace(/[-.]/g, "_").toLowerCase();
  if (name.length <= MAX_IDENTIFIER) return null;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_IDENTIFIER - hash.length - 1)}_${hash}`;
};

/** `->constrained('target')`, naming the key when Laravel's name would not fit. */
export const constrainedTo = (table: string, column: string, target: string): string => {
  const name = indexName(table, [column], "foreign");
  return name === null
    ? `->constrained('${target}')`
    : `->constrained('${target}', indexName: '${name}')`;
};

/** `$table->unique([...])`, naming the index when Laravel's name would not fit. */
export const uniqueOn = (table: string, columns: readonly string[]): string => {
  const name = indexName(table, columns, "unique");
  const list = `[${columns.map((c) => `'${c}'`).join(", ")}]`;
  return name === null ? `$table->unique(${list})` : `$table->unique(${list}, '${name}')`;
};
