import type { Field } from "@camis/ir-schema";
import { snakeColumn } from "./names";

const SUPPORTED = new Set<string>([
  "string",
  "text",
  "email",
  "uid",
  "integer",
  "float",
  "boolean",
  "dateTime",
]);
export const isSupported8A = (t: string): boolean => SUPPORTED.has(t);

export interface ColumnEmit {
  column: string;
  drizzle: string;
  import: "text" | "integer" | "real";
}

const tsLiteral = (v: unknown): string =>
  typeof v === "boolean"
    ? v
      ? "true"
      : "false"
    : typeof v === "number"
      ? String(v)
      : `'${String(v)}'`;

export const emitColumn = (field: Field): ColumnEmit => {
  const f = field as Field & Record<string, unknown>;
  const c = snakeColumn(field.name);
  let base: string;
  let imp: ColumnEmit["import"];
  switch (field.type) {
    case "integer":
      base = `integer('${c}')`;
      imp = "integer";
      break;
    case "float":
      base = `real('${c}')`;
      imp = "real";
      break;
    case "boolean":
      base = `integer('${c}', { mode: 'boolean' })`;
      imp = "integer";
      break;
    case "dateTime":
      base = `integer('${c}', { mode: 'timestamp' })`;
      imp = "integer";
      break;
    default:
      // string | text | email | uid
      base = `text('${c}')`;
      imp = "text";
  }
  const drizzle =
    base +
    (f.required === true ? ".notNull()" : "") +
    (f.unique === true ? ".unique()" : "") +
    (f.default !== undefined ? `.default(${tsLiteral(f.default)})` : "");
  return { column: c, drizzle, import: imp };
};
