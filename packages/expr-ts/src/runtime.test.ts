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
});

describe("runtime arithmetic", () => {
  it("add numbers", () => expect(r.add(num(2), num(3))).toEqual({ ok: true, value: 5 }));
  it("div", () => expect(r.div(num(7), num(2))).toEqual({ ok: true, value: 3.5 }));
  it("div by zero → DIV_BY_ZERO", () =>
    expect(r.div(num(1), num(0))).toEqual({ ok: false, error: "DIV_BY_ZERO" }));
  it("add non-number → TYPE_MISMATCH", () =>
    expect(r.add(num(1), str("x"))).toEqual({ ok: false, error: "TYPE_MISMATCH" }));
});
