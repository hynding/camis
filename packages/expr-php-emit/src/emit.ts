import type { Expression, Value } from "@camis/expr";

const phpLiteral = (value: Value): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  return JSON.stringify(value);
};

const operand = (e: Expression): string => `fn() => ${emitPhp(e)}`;

export const emitPhp = (expr: Expression): string => {
  switch (expr.kind) {
    case "lit":
      return `Ring1::lit(${phpLiteral(expr.value)})`;
    case "var":
      return `Ring1::var($data, ${JSON.stringify(expr.name)})`;
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
      return `Ring1::${expr.kind}(${operand(expr.left)}, ${operand(expr.right)})`;
    case "and":
    case "or":
      return `Ring1::${expr.kind}(${expr.args.map(operand).join(", ")})`;
    case "not":
      return `Ring1::not(${operand(expr.arg)})`;
    case "call":
      return expr.fn === "isNull"
        ? `Ring1::isNull(${operand(expr.args[0]!)})`
        : `Ring1::coalesce(${expr.args.map(operand).join(", ")})`;
  }
};
