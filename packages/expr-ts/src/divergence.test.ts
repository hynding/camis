import { describe, expect, it } from "vitest";
import { vectors } from "@camis/expr";
import { evaluate } from "./evaluate";

describe("divergence detection", () => {
  it("a wrong expected-value would fail the conformance assertion", () => {
    // Simulate a divergent runtime by mutating the expected result and confirming the comparison rejects it.
    const v = vectors.find((x) => x.name === "div by zero")!;
    const wrong = { ok: true, value: 0 } as const;
    expect(evaluate(v.expr, v.data)).not.toEqual(wrong); // the real runtime must NOT match a divergent expectation
    expect(evaluate(v.expr, v.data)).toEqual(v.expect);
  });
});
