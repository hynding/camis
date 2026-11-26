import { beyondDouble, decimalDigits } from "@camis/ir-core";
import { STRING_LENGTH, stringColumn, textTier } from "@camis/adapter-kernel";
import type { Field } from "@camis/ir-schema";
import type { Dialect } from "./dialect";
import { snakeColumn } from "./names";

const SUPPORTED = new Set<string>([
  "string",
  "text",
  "richText",
  "email",
  "uid",
  "color",
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

/**
 * A decimal's column, with its digits where it states them. SQLite keeps a NUMERIC column's values
 * as doubles and takes no digits, so a decimal beyond a double is text there, keeping every digit.
 */
const decimalColumn = (
  dialect: Dialect,
  field: Field,
  c: string,
): { expr: string; import: string } => {
  const digits = decimalDigits(field);
  const config =
    digits === undefined ? "" : `, { precision: ${digits.precision}, scale: ${digits.scale} }`;
  if (dialect === "mysql") return { expr: `decimal('${c}'${config})`, import: "decimal" };
  if (dialect === "pgsql") return { expr: `numeric('${c}'${config})`, import: "numeric" };
  return beyondDouble(field)
    ? { expr: `text('${c}')`, import: "text" }
    : { expr: `numeric('${c}')`, import: "numeric" };
};

// MySQL's TEXT holds 65,535 bytes: a text takes the smallest of its text types that holds its bound.
const MYSQL_TEXT_BY_TIER = { small: "text", medium: "mediumtext", large: "longtext" } as const;

const mysqlText = (field: Field, c: string): { expr: string; import: string } => {
  const type = MYSQL_TEXT_BY_TIER[textTier(field)];
  return { expr: `${type}('${c}')`, import: type };
};

const varchar = (c: string, length: number): { expr: string; import: string } => ({
  expr: `varchar('${c}', { length: ${length} })`,
  import: "varchar",
});

/**
 * A string's column. SQLite's text takes any length. On MySQL a string column's whole length counts
 * toward a row's bytes and a text column cannot be indexed whole, so `stringColumn` decides; on
 * PostgreSQL a bound past `STRING_LENGTH` is text, which takes any length and a unique index.
 */
const stringBase = (
  dialect: Dialect,
  field: Field,
  c: string,
): { expr: string; import: string } => {
  const f = field as Field & { maxLength?: number; unique?: boolean };
  if (dialect === "sqlite") return { expr: `text('${c}')`, import: "text" };
  if (dialect === "pgsql")
    return f.maxLength !== undefined && f.maxLength > STRING_LENGTH
      ? { expr: `text('${c}')`, import: "text" }
      : varchar(c, f.maxLength ?? STRING_LENGTH);
  const column = stringColumn(f);
  if (column.kind === "string") return varchar(c, column.length ?? STRING_LENGTH);
  const type = MYSQL_TEXT_BY_TIER[column.tier];
  return { expr: `${type}('${c}')`, import: type };
};

// Per-dialect base column (expression WITHOUT modifiers) + the drizzle-core import it needs.
const base = (dialect: Dialect, field: Field, c: string): { expr: string; import: string } => {
  switch (field.type) {
    case "string":
    case "email":
    case "uid":
      return stringBase(dialect, field, c);
    case "color":
      return dialect === "sqlite"
        ? { expr: `text('${c}')`, import: "text" }
        : { expr: `varchar('${c}', { length: 255 })`, import: "varchar" };
    case "text":
    case "richText":
      return dialect === "mysql" ? mysqlText(field, c) : { expr: `text('${c}')`, import: "text" };
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
      return decimalColumn(dialect, field, c);
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
  // A decimal kept as text (see decimalColumn) takes its default as text too.
  const defaultValue =
    b.import === "text" && typeof f.default === "number" ? String(f.default) : f.default;
  const drizzle =
    b.expr +
    (f.required === true ? ".notNull()" : "") +
    (f.unique === true ? ".unique()" : "") +
    (defaultValue !== undefined ? `.default(${tsLiteral(defaultValue)})` : "");
  return { column: c, drizzle, import: b.import };
};
