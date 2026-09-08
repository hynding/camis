import type { Expression } from "@camis/expr";
import type { ContentType, FieldType } from "@camis/ir-schema";
import { snakeColumn } from "../names";

export { renderEloquent } from "./render-eloquent";
export { renderSql } from "./render-sql";

export type WhereValue =
  | { kind: "lit"; value: string | number | boolean | null }
  | { kind: "userId" };
export type WhereNode =
  | { kind: "eq"; column: string; value: WhereValue }
  | { kind: "and" | "or"; args: WhereNode[] };

export interface WhereContext {
  columns: Map<string, { column: string; type: FieldType }>;
}

const NUMERIC = new Set<FieldType>(["integer", "bigInteger", "float", "decimal"]);
const STRINGY = new Set<FieldType>([
  "string",
  "text",
  "richText",
  "email",
  "uid",
  "enumeration",
  "date",
  "time",
  "dateTime",
  "timestamp",
]);

/** Maps Ring 1 `record.*` variable names to their SQL column + IR type for one content type. */
export const whereContext = (ct: ContentType): WhereContext => {
  const columns = new Map<string, { column: string; type: FieldType }>();
  for (const f of ct.fields) {
    if (f.type === "relation") {
      if (f.relationKind === "manyToOne" || f.relationKind === "oneToOne") {
        columns.set(`record.${f.name}Id`, { column: `${snakeColumn(f.name)}_id`, type: "integer" });
      }
      continue;
    }
    if (f.type === "component" || f.type === "dynamicZone") continue;
    columns.set(`record.${f.name}`, { column: snakeColumn(f.name), type: f.type });
  }
  return { columns };
};

const compatible = (type: FieldType, value: WhereValue): boolean => {
  if (value.kind === "userId") return NUMERIC.has(type);
  const v = value.value;
  if (v === null) return true;
  if (typeof v === "number") return NUMERIC.has(type);
  if (typeof v === "boolean") return type === "boolean";
  return STRINGY.has(type);
};

const operand = (
  e: Expression,
  ctx: WhereContext,
): { column: string; type: FieldType } | WhereValue | null => {
  if (e.kind === "lit") return { kind: "lit", value: e.value };
  if (e.kind === "var") {
    if (e.name === "user.id") return { kind: "userId" };
    return ctx.columns.get(e.name) ?? null;
  }
  return null;
};

const isColumn = (o: unknown): o is { column: string; type: FieldType } =>
  typeof o === "object" && o !== null && "column" in o;

/** Ring 1 predicate → WhereNode, or null when it cannot be expressed as SQL with identical semantics. */
export const toWhereNode = (expr: Expression, ctx: WhereContext): WhereNode | null => {
  switch (expr.kind) {
    case "eq": {
      const l = operand(expr.left, ctx);
      const r = operand(expr.right, ctx);
      if (l === null || r === null) return null;
      const col = isColumn(l) ? l : isColumn(r) ? r : null;
      const val = isColumn(l) ? r : l;
      if (col === null || isColumn(val)) return null; // record-vs-record or lit-vs-lit
      if (!compatible(col.type, val)) return null;
      return { kind: "eq", column: col.column, value: val };
    }
    case "and":
    case "or": {
      const args: WhereNode[] = [];
      for (const a of expr.args) {
        const n = toWhereNode(a, ctx);
        if (n === null) return null;
        args.push(n);
      }
      return { kind: expr.kind, args };
    }
    default:
      return null;
  }
};
