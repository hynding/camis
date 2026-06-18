import type { Field } from "@camis/ir-schema";
import type { Dialect } from "./dialect";
import { snakeColumn } from "./names";

const SUPPORTED = new Set<string>([
  "string",
  "text",
  "richText",
  "email",
  "uid",
  "integer",
  "bigInteger",
  "float",
  "decimal",
  "boolean",
  "enumeration",
  "date",
  "time",
  "dateTime",
  "timestamp",
  "json",
  "media",
]);
export const isSupportedField = (t: string): boolean => SUPPORTED.has(t);

export interface ColumnEmit {
  column: string;
  drizzle: string;
  import: string; // the drizzle-core import the base column needs
}

// Emit a string default as a single-quoted TS literal, escaping backslashes and quotes so an
// author-controlled default cannot break out of (or inject code into) the generated schema.
const tsLiteral = (v: unknown): string =>
  typeof v === "boolean"
    ? v
      ? "true"
      : "false"
    : typeof v === "number"
      ? String(v)
      : `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// Per-dialect base column (expression WITHOUT modifiers) + the drizzle-core import it needs.
const base = (dialect: Dialect, field: Field, c: string): { expr: string; import: string } => {
  switch (field.type) {
    case "string":
    case "email":
    case "uid":
      return dialect === "sqlite"
        ? { expr: `text('${c}')`, import: "text" }
        : { expr: `varchar('${c}', { length: 255 })`, import: "varchar" };
    case "text":
    case "richText":
    case "media":
    case "enumeration":
      return { expr: `text('${c}')`, import: "text" };
    case "integer":
      return dialect === "mysql"
        ? { expr: `int('${c}')`, import: "int" }
        : { expr: `integer('${c}')`, import: "integer" };
    case "bigInteger":
      return dialect === "sqlite"
        ? { expr: `integer('${c}')`, import: "integer" }
        : { expr: `bigint('${c}', { mode: 'number' })`, import: "bigint" };
    case "float":
      return dialect === "mysql"
        ? { expr: `float('${c}')`, import: "float" }
        : { expr: `real('${c}')`, import: "real" };
    case "decimal":
      return dialect === "mysql"
        ? { expr: `decimal('${c}')`, import: "decimal" }
        : { expr: `numeric('${c}')`, import: "numeric" };
    case "boolean":
      return dialect === "sqlite"
        ? { expr: `integer('${c}', { mode: 'boolean' })`, import: "integer" }
        : { expr: `boolean('${c}')`, import: "boolean" };
    case "json":
      return dialect === "sqlite"
        ? { expr: `text('${c}', { mode: 'json' })`, import: "text" }
        : dialect === "pgsql"
          ? { expr: `jsonb('${c}')`, import: "jsonb" }
          : { expr: `json('${c}')`, import: "json" };
    case "date":
      return dialect === "sqlite"
        ? { expr: `integer('${c}', { mode: 'timestamp' })`, import: "integer" }
        : { expr: `date('${c}')`, import: "date" };
    case "time":
      return dialect === "sqlite"
        ? { expr: `text('${c}')`, import: "text" }
        : { expr: `time('${c}')`, import: "time" };
    case "dateTime":
    case "timestamp":
      return dialect === "sqlite"
        ? { expr: `integer('${c}', { mode: 'timestamp' })`, import: "integer" }
        : { expr: `timestamp('${c}')`, import: "timestamp" };
    default:
      return dialect === "sqlite"
        ? { expr: `text('${c}')`, import: "text" }
        : { expr: `varchar('${c}', { length: 255 })`, import: "varchar" };
  }
};

export const column = (dialect: Dialect, field: Field): ColumnEmit => {
  const f = field as Field & Record<string, unknown>;
  const c = snakeColumn(field.name);
  const b = base(dialect, field, c);
  const drizzle =
    b.expr +
    (f.required === true ? ".notNull()" : "") +
    (f.unique === true ? ".unique()" : "") +
    (f.default !== undefined ? `.default(${tsLiteral(f.default)})` : "");
  return { column: c, drizzle, import: b.import };
};
