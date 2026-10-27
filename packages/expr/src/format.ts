import type { Expression } from "./ast";

const COMPARISON = { eq: "=", ne: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" } as const;
const ARITHMETIC = { add: "+", sub: "-", mul: "*", div: "/" } as const;

const precedence = (e: Expression): number => {
  switch (e.kind) {
    case "or":
      return 1;
    case "and":
      return 2;
    case "not":
      return 3;
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return 4;
    case "add":
    case "sub":
      return 5;
    case "mul":
    case "div":
      return 6;
    default:
      return 7;
  }
};

/** An operand, bracketed when it binds looser than its parent (or as loosely, when `strict`). */
const operand = (e: Expression, parent: number, strict = false): string => {
  const text = formatExpression(e);
  const own = precedence(e);
  return own < parent || (strict && own === parent) ? `(${text})` : text;
};

/** A Ring 1 expression in a compact infix form, for people to read (a grant's condition). */
export const formatExpression = (e: Expression): string => {
  switch (e.kind) {
    case "lit":
      return JSON.stringify(e.value);
    case "var":
      return e.name;
    case "eq":
    case "ne":
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return `${operand(e.left, 4, true)} ${COMPARISON[e.kind]} ${operand(e.right, 4, true)}`;
    case "add":
    case "sub":
    case "mul":
    case "div": {
      const own = precedence(e);
      return `${operand(e.left, own)} ${ARITHMETIC[e.kind]} ${operand(e.right, own, true)}`;
    }
    case "and":
    case "or": {
      const own = precedence(e);
      return e.args.map((arg) => operand(arg, own, true)).join(` ${e.kind} `);
    }
    case "not":
      return `not ${operand(e.arg, 3)}`;
    case "call":
      return `${e.fn}(${e.args.map(formatExpression).join(", ")})`;
  }
};
