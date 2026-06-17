import type { Expression } from "@camis/expr";

const operand = (e: Expression): string => `() => ${emitTs(e)}`;

export const emitTs = (expr: Expression): string => {
  switch (expr.kind) {
    case "lit":
      return `r.lit(${JSON.stringify(expr.value)})`;
    case "var":
      return `r.var(data, ${JSON.stringify(expr.name)})`;
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
    case "add":
    case "sub":
    case "mul":
    case "div":
      return `r.${expr.kind}(${operand(expr.left)}, ${operand(expr.right)})`;
    case "and":
    case "or":
      return `r.${expr.kind}(${expr.args.map(operand).join(", ")})`;
    case "not":
      return `r.not(${operand(expr.arg)})`;
    case "call":
      return expr.fn === "isNull"
        ? `r.isNull(${operand(expr.args[0]!)})`
        : `r.coalesce(${expr.args.map(operand).join(", ")})`;
  }
};
