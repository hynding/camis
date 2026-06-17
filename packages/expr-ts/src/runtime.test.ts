import { describe, expect, it } from "vitest";
import type { EvalResult } from "@camis/expr";
import { r } from "./runtime";

const t = (res: EvalResult) => () => res;
const num = (n: number) => t({ ok: true, value: n });
const str = (s: string) => t({ ok: true, value: s });

describe("runtime leaves", () => {
  it("lit returns ok", () => expect(r.lit(5)).toEqual({ ok: true, value: 5 }));
  it("var found", () => expect(r.var({ a: 1 }, "a")).toEqual({ ok: true, value: 1 }));
  it("var missing → UNKNOWN_VAR", () =>
    expect(r.var({}, "a")).toEqual({ ok: false, error: "UNKNOWN_VAR" }));
});

describe("runtime comparison", () => {
  it("eq same type", () => expect(r.eq(num(1), num(1))).toEqual({ ok: true, value: true }));
  it("eq null both", () =>
    expect(r.eq(t(r.lit(null)), t(r.lit(null)))).toEqual({ ok: true, value: true }));
  it("eq one null → false", () =>
    expect(r.eq(t(r.lit(null)), num(1))).toEqual({ ok: true, value: false }));
  it("eq mixed non-null type → TYPE_MISMATCH", () =>
    expect(r.eq(num(1), str("1"))).toEqual({ ok: false, error: "TYPE_MISMATCH" }));
  it("lt numbers", () => expect(r.lt(num(1), num(2))).toEqual({ ok: true, value: true }));
  it("lt strings (ascii codepoint)", () =>
    expect(r.lt(str("a"), str("b"))).toEqual({ ok: true, value: true }));
  it("lt mixed type → TYPE_MISMATCH", () =>
    expect(r.lt(num(1), str("a"))).toEqual({ ok: false, error: "TYPE_MISMATCH" }));
  it("propagates operand error", () =>
    expect(r.eq(t({ ok: false, error: "UNKNOWN_VAR" }), num(1))).toEqual({
      ok: false,
      error: "UNKNOWN_VAR",
    }));

  it("ne equal → false", () => expect(r.ne(num(1), num(1))).toEqual({ ok: true, value: false }));
  it("ne unequal → true", () => expect(r.ne(num(1), num(2))).toEqual({ ok: true, value: true }));
  it("ne null both → false", () =>
    expect(r.ne(t(r.lit(null)), t(r.lit(null)))).toEqual({ ok: true, value: false }));
  it("ne mixed non-null type → TYPE_MISMATCH", () =>
    expect(r.ne(num(1), str("1"))).toEqual({ ok: false, error: "TYPE_MISMATCH" }));

  it("lte equal → true", () => expect(r.lte(num(2), num(2))).toEqual({ ok: true, value: true }));
  it("gt numbers", () => expect(r.gt(num(2), num(1))).toEqual({ ok: true, value: true }));
  it("gte equal → true", () => expect(r.gte(num(2), num(2))).toEqual({ ok: true, value: true }));

  // Pins direct < / > ordering: subtraction would lose this near MAX_SAFE_INTEGER.
  it("gt large integers (no precision loss)", () =>
    expect(r.gt(num(Number.MAX_SAFE_INTEGER), num(Number.MAX_SAFE_INTEGER - 1))).toEqual({
      ok: true,
      value: true,
    }));

  // String ordering is lexicographic codepoint, not numeric: "10" < "9".
  it("lt strings lexicographic not numeric", () =>
    expect(r.lt(str("10"), str("9"))).toEqual({ ok: true, value: true }));
});

describe("runtime arithmetic", () => {
  it("add numbers", () => expect(r.add(num(2), num(3))).toEqual({ ok: true, value: 5 }));
  it("div", () => expect(r.div(num(7), num(2))).toEqual({ ok: true, value: 3.5 }));
  it("div by zero → DIV_BY_ZERO", () =>
    expect(r.div(num(1), num(0))).toEqual({ ok: false, error: "DIV_BY_ZERO" }));
  it("add non-number → TYPE_MISMATCH", () =>
    expect(r.add(num(1), str("x"))).toEqual({ ok: false, error: "TYPE_MISMATCH" }));
  it("sub numbers", () => expect(r.sub(num(5), num(3))).toEqual({ ok: true, value: 2 }));
  it("mul numbers", () => expect(r.mul(num(4), num(3))).toEqual({ ok: true, value: 12 }));
});

describe("runtime boolean + functions", () => {
  const T = () => ({ ok: true, value: true }) as const;
  const F = () => ({ ok: true, value: false }) as const;
  const boom = () => ({ ok: false, error: "UNKNOWN_VAR" }) as const;

  it("and short-circuits on false (does not force later)", () => {
    let forced = false;
    const r2 = () => {
      forced = true;
      return { ok: true, value: true } as const;
    };
    expect(r.and(F, r2)).toEqual({ ok: true, value: false });
    expect(forced).toBe(false);
  });
  it("and all true", () => expect(r.and(T, T)).toEqual({ ok: true, value: true }));
  it("and non-boolean operand → TYPE_MISMATCH", () =>
    expect(r.and(T, () => ({ ok: true, value: 1 }))).toEqual({
      ok: false,
      error: "TYPE_MISMATCH",
    }));
  it("and propagates error", () =>
    expect(r.and(T, boom)).toEqual({ ok: false, error: "UNKNOWN_VAR" }));
  it("or short-circuits on true", () => expect(r.or(T, boom)).toEqual({ ok: true, value: true }));
  it("or all false", () => expect(r.or(F, F)).toEqual({ ok: true, value: false }));
  it("or non-boolean operand → TYPE_MISMATCH", () =>
    expect(r.or(F, () => ({ ok: true, value: 1 }))).toEqual({
      ok: false,
      error: "TYPE_MISMATCH",
    }));
  it("not", () => expect(r.not(T)).toEqual({ ok: true, value: false }));
  it("not non-boolean → TYPE_MISMATCH", () =>
    expect(r.not(() => ({ ok: true, value: 1 }))).toEqual({ ok: false, error: "TYPE_MISMATCH" }));
  it("isNull true/false", () => {
    expect(r.isNull(() => ({ ok: true, value: null }))).toEqual({ ok: true, value: true });
    expect(r.isNull(() => ({ ok: true, value: 0 }))).toEqual({ ok: true, value: false });
  });
  it("coalesce returns first non-null", () =>
    expect(
      r.coalesce(
        () => ({ ok: true, value: null }),
        () => ({ ok: true, value: 5 }),
      ),
    ).toEqual({ ok: true, value: 5 }));
  it("coalesce all null → null", () =>
    expect(r.coalesce(() => ({ ok: true, value: null }))).toEqual({ ok: true, value: null }));
  it("coalesce propagates error reached before a non-null", () =>
    expect(
      r.coalesce(
        () => ({ ok: true, value: null }),
        boom,
        () => ({ ok: true, value: 5 }),
      ),
    ).toEqual({ ok: false, error: "UNKNOWN_VAR" }));
});
