import type { WhereNode, WhereValue } from "./query-ast";

const phpLit = (v: WhereValue): string => {
  if (v.kind === "userId") return "$user->id";
  const x = v.value;
  if (x === null) return "null";
  if (typeof x === "boolean") return x ? "true" : "false";
  if (typeof x === "number") return JSON.stringify(x);
  return `'${x.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
};

const stmt = (node: WhereNode, q: string, user: string, or: boolean): string => {
  const method = or ? "orWhere" : "where";
  if (node.kind === "eq") {
    if (node.link !== undefined) {
      const { table, local, foreign, owner } = node.link;
      const isNull = node.value.kind === "lit" && node.value.value === null;
      const existsMethod = isNull
        ? or
          ? "orWhereNotExists"
          : "whereNotExists"
        : or
          ? "orWhereExists"
          : "whereExists";
      const extra = isNull ? "" : `->where('${table}.${foreign}', ${phpLit(node.value)})`;
      return `${q}->${existsMethod}(function ($s) use (${user}) { $s->selectRaw('1')->from('${table}')->whereColumn('${table}.${local}', '${owner}.id')${extra}; });`;
    }
    if (node.value.kind === "lit" && node.value.value === null) {
      return `${q}->${or ? "orWhereNull" : "whereNull"}('${node.column}');`;
    }
    return `${q}->${method}('${node.column}', '=', ${phpLit(node.value)});`;
  }
  const inner = node.args.map((a, i) => stmt(a, "$q", user, node.kind === "or" && i > 0)).join(" ");
  return `${q}->${method}(function ($q) use (${user}) { ${inner} });`;
};

/** PHP statements applying `node` to the Eloquent/Query Builder variable `q` for `user`. */
export const renderEloquent = (node: WhereNode, q: string, user: string): string =>
  stmt(node, q, user, false);
