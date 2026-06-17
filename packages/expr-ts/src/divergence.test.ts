import { describe, expect, it } from "vitest";
import { vectors } from "@camis/expr";
import { r } from "./runtime";
import { emitTs } from "./emit";

describe("divergence detection", () => {
  it("a runtime that disagrees with a vector fails the conformance assertion", () => {
    const v = vectors.find((x) => x.name === "div by zero")!;
    const code = "return " + emitTs(v.expr);
    // A deliberately-broken runtime: div ignores the zero divisor and returns 0 instead of DIV_BY_ZERO.
    const brokenRuntime = { ...r, div: () => ({ ok: true as const, value: 0 }) };
    const run = new Function("r", "data", code) as (rt: unknown, d: unknown) => unknown;
    const broken = run(brokenRuntime, v.data);
    expect(broken).not.toEqual(v.expect); // the broken runtime would make conformance go RED
    const real = run(r, v.data);
    expect(real).toEqual(v.expect); // the real runtime matches
  });
});
