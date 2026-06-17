import { describe, expect, it } from "vitest";
import { err, ok, type EvalResult } from "./value";

describe("EvalResult helpers", () => {
  it("ok wraps a value", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });
  it("err wraps an error code", () => {
    const r: EvalResult = err("DIV_BY_ZERO");
    expect(r).toEqual({ ok: false, error: "DIV_BY_ZERO" });
  });
});
