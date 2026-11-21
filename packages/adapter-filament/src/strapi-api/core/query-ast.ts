import type { StorageLayout } from "@camis/adapter-kernel";
import type { Expression } from "@camis/expr";
import type { ContentType, FieldType } from "@camis/ir-schema";
import { CREATED_BY, CREATOR_SHARES_ROLE, recordEquality } from "@camis/permissions";
import { snakeColumn } from "../../names";
import { linkColumns, linkTable, strapiTable, type RelationField } from "../storage/names";

export { renderEloquent } from "./render-eloquent";
export { renderSql } from "./render-sql";
// Re-exported for `scope.ts`, which reaches the layout distinction through this module.
export type { StorageLayout };

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
  /** The row's creating admin account holds one of the user's roles (has-same-role-as-creator). */
  | { kind: "creatorSharesRole" }
  | { kind: "and" | "or"; args: WhereNode[] };

export interface WhereContext {
  columns: Map<string, { column: string; type: FieldType; link?: LinkInfo }>;
  /** The table records each row's creating admin account. */
  creators?: boolean;
}

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
export const whereContext = (
  ct: ContentType,
  layout: StorageLayout = "laravel",
  /** The table records the admin account that created each row (Strapi's createdBy). */
  creators = false,
): WhereContext => {
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
  if (creators) claim(CREATED_BY, { column: "created_by_id", type: "integer" });
  for (const key of collided) columns.delete(key);
  return creators ? { columns, creators } : { columns };
};

/** Ring 1 predicate → WhereNode, or null when it cannot be expressed as SQL with identical semantics. */
const isSharesRole = (e: Expression, ctx: WhereContext): boolean =>
  ctx.creators === true &&
  !ctx.columns.has(CREATOR_SHARES_ROLE) &&
  e.kind === "eq" &&
  ((e.left.kind === "var" &&
    e.left.name === CREATOR_SHARES_ROLE &&
    e.right.kind === "lit" &&
    e.right.value === true) ||
    (e.right.kind === "var" &&
      e.right.name === CREATOR_SHARES_ROLE &&
      e.left.kind === "lit" &&
      e.left.value === true));

export const toWhereNode = (expr: Expression, ctx: WhereContext): WhereNode | null => {
  if (isSharesRole(expr, ctx)) return { kind: "creatorSharesRole" };
  switch (expr.kind) {
    case "eq": {
      // Only the caller's id binds here: the SQL renderers have no other user value to hand.
      const equality = recordEquality(expr, (name) => ctx.columns.get(name)?.type, ["user.id"]);
      if (equality === null) return null;
      const col = ctx.columns.get(equality.variable)!;
      const value: WhereValue =
        equality.value.kind === "user"
          ? { kind: "userId" }
          : { kind: "lit", value: equality.value.value };
      return col.link !== undefined
        ? { kind: "eq", column: col.column, value, link: col.link }
        : { kind: "eq", column: col.column, value };
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

/**
 * `node` for a caller without a session, whose absent `user.id` equals no row: each equality with
 * it folds to false, and true or false is returned when nothing is left to ask the database. Ring 1
 * fails such a comparison closed rather than false, which can only deny more, and the policy
 * re-checks every row the scope lets through, so the scope is never the looser of the two.
 */
export const withoutUser = (node: WhereNode): WhereNode | boolean => {
  if (node.kind === "eq") return node.value.kind === "userId" ? false : node;
  if (node.kind === "creatorSharesRole") return false;
  const absorbing = node.kind === "and" ? false : true;
  const args = node.args.map(withoutUser);
  if (args.includes(absorbing)) return absorbing;
  const rest = args.filter((a): a is WhereNode => typeof a !== "boolean");
  if (rest.length === 0) return !absorbing;
  return rest.length === 1 ? rest[0]! : { kind: node.kind, args: rest };
};
