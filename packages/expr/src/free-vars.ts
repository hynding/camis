import type { Expression } from "./ast";

/** Distinct variable names referenced by an expression (sorted). Pure AST walk. */
export const freeVars = (expr: Expression): string[] => {
  const acc = new Set<string>();
  const walk = (e: Expression): void => {
    switch (e.kind) {
      case "lit":
        return;
      case "var":
        acc.add(e.name);
        return;
      case "not":
        walk(e.arg);
        return;
      case "and":
      case "or":
      case "call":
        e.args.forEach(walk);
        return;
      default:
        walk(e.left);
        walk(e.right);
    }
  };
  walk(expr);
  return [...acc].sort();
};
