import type { Expression } from "@camis/expr";
import type { ContentType, FieldType } from "@camis/ir-schema";
import { snakeColumn } from "../names";
import { linkColumns, linkTable, strapiTable, type RelationField } from "./storage/names";

export { renderEloquent } from "./render-eloquent";
export { renderSql } from "./render-sql";

export type WhereValue =
  | { kind: "lit"; value: string | number | boolean | null }
  | { kind: "userId" };

/**
 * Where an owning relation's link-table row lives, for the strapi storage layout. `owner` is the
 * content type's own table (Task 5's `strapiTable`) — the row an `EXISTS`/`whereExists` subquery
 * joins back to; `local`/`foreign` are the link table's two FK columns (Task 5's `linkColumns`).
 */
export interface LinkInfo {
  table: string;
  local: string;
  foreign: string;
  owner: string;
}

export type WhereNode =
  | { kind: "eq"; column: string; value: WhereValue; link?: LinkInfo }
  | { kind: "and" | "or"; args: WhereNode[] };

export interface WhereContext {
  columns: Map<string, { column: string; type: FieldType; link?: LinkInfo }>;
}

export type StorageLayout = "laravel" | "strapi";

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

/**
 * Maps Ring 1 `record.*` variable names to their SQL column + IR type for one content type.
 *
 * A scalar `creatorId` and a manyToOne relation `creator` both claim the name `record.creatorId`
 * while meaning different columns. Rather than let one silently win — which would compile the
 * condition against the wrong column — a contested key is dropped entirely, so `toWhereNode`
 * returns null for it and the caller takes the documented fetch-then-filter fallback.
 *
 * In the `strapi` layout, an owning relation (`manyToOne`/`oneToOne`) is not a foreign-key column
 * on this table at all — Strapi 5 stores it as a row in a link table — so the entry additionally
 * carries `link`, naming that table (Task 5's `linkTable`/`linkColumns`/`strapiTable`) so
 * `toWhereNode`/the renderers can compile the equality as an `EXISTS` subquery instead of a plain
 * column comparison. `column` is still populated (as `<name>_id`) for shape parity but goes unused
 * whenever `link` is set. The `laravel` layout (the default) is unchanged.
 */
export const whereContext = (ct: ContentType, layout: StorageLayout = "laravel"): WhereContext => {
  const columns = new Map<string, { column: string; type: FieldType; link?: LinkInfo }>();
  const collided = new Set<string>();
  const claim = (
    key: string,
    entry: { column: string; type: FieldType; link?: LinkInfo },
  ): void => {
    if (columns.has(key)) collided.add(key);
    columns.set(key, entry);
  };
  for (const f of ct.fields) {
    if (f.type === "relation") {
      if (f.relationKind === "manyToOne" || f.relationKind === "oneToOne") {
        const column = `${snakeColumn(f.name)}_id`;
        if (layout === "strapi") {
          const cols = linkColumns(ct, f as RelationField);
          claim(`record.${f.name}Id`, {
            column,
            type: "integer",
            link: {
              table: linkTable(ct, f.name),
              local: cols.local,
              foreign: cols.foreign,
              owner: strapiTable(ct),
            },
          });
        } else {
          claim(`record.${f.name}Id`, { column, type: "integer" });
        }
      }
      continue;
    }
    if (f.type === "component" || f.type === "dynamicZone") continue;
    claim(`record.${f.name}`, { column: snakeColumn(f.name), type: f.type });
  }
  for (const key of collided) columns.delete(key);
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
): { column: string; type: FieldType; link?: LinkInfo } | WhereValue | null => {
  if (e.kind === "lit") return { kind: "lit", value: e.value };
  if (e.kind === "var") {
    if (e.name === "user.id") return { kind: "userId" };
    return ctx.columns.get(e.name) ?? null;
  }
  return null;
};

const isColumn = (o: unknown): o is { column: string; type: FieldType; link?: LinkInfo } =>
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
      return col.link !== undefined
        ? { kind: "eq", column: col.column, value: val, link: col.link }
        : { kind: "eq", column: col.column, value: val };
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
