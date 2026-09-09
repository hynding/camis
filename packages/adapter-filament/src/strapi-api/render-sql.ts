import { sqlSingleQuoted } from "../php-literal";
import type { WhereNode, WhereValue } from "./query-ast";

const sqlLit = (v: WhereValue, userId: number): string => {
  if (v.kind === "userId") return String(userId);
  const x = v.value;
  if (x === null) return "NULL";
  if (typeof x === "boolean") return x ? "1" : "0";
  if (typeof x === "number") return String(x);
  return sqlSingleQuoted(x);
};

/**
 * Test-only SQL WHERE body for `node`, with `user.id` inlined as `userId` — the conformance suite
 * runs it against a temporary SQLite file to prove `renderEloquent` and the TS evaluator agree.
 *
 * Values go through the shared `sqlSingleQuoted`; identifiers are interpolated bare, because
 * quoting them would change the SQL this suite pins byte for byte and nothing here ever reaches a
 * real database. The PHP the generator actually ships quotes both (see `render-eloquent.ts`).
 */
export const renderSql = (node: WhereNode, userId: number): string => {
  if (node.kind === "eq") {
    if (node.link !== undefined) {
      const { table, local, foreign, owner } = node.link;
      const join = `${table}.${local} = ${owner}.id`;
      if (node.value.kind === "lit" && node.value.value === null) {
        return `NOT EXISTS (SELECT 1 FROM ${table} WHERE ${join})`;
      }
      return `EXISTS (SELECT 1 FROM ${table} WHERE ${join} AND ${table}.${foreign} = ${sqlLit(node.value, userId)})`;
    }
    if (node.value.kind === "lit" && node.value.value === null) return `(${node.column} IS NULL)`;
    return `(${node.column} = ${sqlLit(node.value, userId)})`;
  }
  return `(${node.args.map((a) => renderSql(a, userId)).join(node.kind === "and" ? " AND " : " OR ")})`;
};
