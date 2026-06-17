import { describe, expect, it } from "vitest";
import { expression } from "./ast";
import { vectors } from "./vectors";

describe("vectors", () => {
  it("every vector's expr is a valid Expression", () => {
    for (const v of vectors) expect(expression.safeParse(v.expr).success).toBe(true);
  });
  it("covers every operator and every error code", () => {
    const kinds = new Set(vectors.map((v) => v.expr.kind));
    for (const k of [
      "lit",
      "var",
      "eq",
      "ne",
      "lt",
      "lte",
      "gt",
      "gte",
      "add",
      "sub",
      "mul",
      "div",
      "and",
      "or",
      "not",
      "call",
    ]) {
      expect(kinds.has(k as never)).toBe(true);
    }
    const errors = new Set(
      vectors.filter((v) => !v.expect.ok).map((v) => (v.expect.ok ? "" : v.expect.error)),
    );
    for (const e of ["TYPE_MISMATCH", "DIV_BY_ZERO", "UNKNOWN_VAR"])
      expect(errors.has(e as never)).toBe(true);
  });
});
