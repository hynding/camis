import type { EvalResult, Expression, Value } from "@camis/expr";
import { r } from "./runtime";

export const evaluate = (expr: Expression, data: Record<string, Value>): EvalResult => {
  const ev = (e: Expression): EvalResult => {
    switch (e.kind) {
      case "lit":
        return r.lit(e.value);
      case "var":
        return r.var(data, e.name);
      case "eq":
        return r.eq(
          () => ev(e.left),
          () => ev(e.right),
        );
      case "ne":
        return r.ne(
          () => ev(e.left),
          () => ev(e.right),
        );
      case "lt":
        return r.lt(
          () => ev(e.left),
          () => ev(e.right),
        );
      case "lte":
        return r.lte(
          () => ev(e.left),
          () => ev(e.right),
        );
      case "gt":
        return r.gt(
          () => ev(e.left),
          () => ev(e.right),
        );
      case "gte":
        return r.gte(
          () => ev(e.left),
          () => ev(e.right),
        );
      case "add":
        return r.add(
          () => ev(e.left),
          () => ev(e.right),
        );
      case "sub":
        return r.sub(
          () => ev(e.left),
          () => ev(e.right),
        );
      case "mul":
        return r.mul(
          () => ev(e.left),
          () => ev(e.right),
        );
      case "div":
        return r.div(
          () => ev(e.left),
          () => ev(e.right),
        );
      case "and":
        return r.and(...e.args.map((a) => () => ev(a)));
      case "or":
        return r.or(...e.args.map((a) => () => ev(a)));
      case "not":
        return r.not(() => ev(e.arg));
      case "call":
        return e.fn === "isNull"
          ? r.isNull(() => ev(e.args[0]!))
          : r.coalesce(...e.args.map((a) => () => ev(a)));
    }
  };
  return ev(expr);
};
