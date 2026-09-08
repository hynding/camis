import type { WhereNode, WhereValue } from "./query-ast";

const sqlLit = (v: WhereValue, userId: number): string => {
  if (v.kind === "userId") return String(userId);
  const x = v.value;
  if (x === null) return "NULL";
  if (typeof x === "boolean") return x ? "1" : "0";
  if (typeof x === "number") return String(x);
  return `'${x.replace(/'/g, "''")}'`;
};

/** Test-only SQL WHERE body for `node`, with `user.id` inlined as `userId`. */
export const renderSql = (node: WhereNode, userId: number): string => {
  if (node.kind === "eq") {
    if (node.value.kind === "lit" && node.value.value === null) return `(${node.column} IS NULL)`;
    return `(${node.column} = ${sqlLit(node.value, userId)})`;
  }
  return `(${node.args.map((a) => renderSql(a, userId)).join(node.kind === "and" ? " AND " : " OR ")})`;
};
