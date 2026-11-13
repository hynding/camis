import { formatExpression, type Expression } from "@camis/expr";
import { CREATED_BY } from "@camis/permissions";

/**
 * A grant's condition as the Roles page says it: Strapi's own condition by the name its admin
 * gives it ("Is creator"), any other as a sentence over the record's fields and the user's values.
 */

const COMPARISON = {
  eq: "is",
  ne: "is not",
  lt: "is less than",
  lte: "is at most",
  gt: "is more than",
  gte: "is at least",
} as const;
const ARITHMETIC = { add: "+", sub: "-", mul: "*", div: "/" } as const;

const words = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

const isVar = (e: Expression, name: string): boolean => e.kind === "var" && e.name === name;

const isCreator = (e: Expression): boolean =>
  e.kind === "eq" &&
  ((isVar(e.left, CREATED_BY) && isVar(e.right, "user.id")) ||
    (isVar(e.left, "user.id") && isVar(e.right, CREATED_BY)));

const value = (e: Expression): string => {
  switch (e.kind) {
    case "lit":
      return e.value === null ? "empty" : JSON.stringify(e.value);
    case "var":
      if (e.name.startsWith("record.")) return words(e.name.slice("record.".length));
      if (e.name.startsWith("user.")) return `the user's ${words(e.name.slice("user.".length))}`;
      return e.name;
    case "add":
    case "sub":
    case "mul":
    case "div":
      return `${value(e.left)} ${ARITHMETIC[e.kind]} ${value(e.right)}`;
    default:
      return formatExpression(e);
  }
};

const phrase = (e: Expression, inGroup: boolean): string => {
  if (isCreator(e)) return "is creator";
  switch (e.kind) {
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return `${value(e.left)} ${COMPARISON[e.kind]} ${value(e.right)}`;
    case "and":
    case "or": {
      const text = e.args.map((arg) => phrase(arg, true)).join(` ${e.kind} `);
      return inGroup ? `(${text})` : text;
    }
    case "not":
      if (e.arg.kind === "call" && e.arg.fn === "isNull" && e.arg.args.length === 1) {
        return `${value(e.arg.args[0]!)} is not empty`;
      }
      return `not (${phrase(e.arg, false)})`;
    case "call":
      if (e.fn === "isNull" && e.args.length === 1) return `${value(e.args[0]!)} is empty`;
      return formatExpression(e);
    default:
      return value(e);
  }
};

export const readableCondition = (e: Expression): string => {
  const text = phrase(e, false);
  return text.charAt(0).toUpperCase() + text.slice(1);
};
