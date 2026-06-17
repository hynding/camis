import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { vectors } from "@camis/expr";
import { r } from "./runtime";
import { emitTs } from "./emit";

describe("emitTs", () => {
  it("emits a runtime-call expression", () => {
    const e: Expression = {
      kind: "div",
      left: { kind: "var", name: "a" },
      right: { kind: "lit", value: 0 },
    };
    expect(emitTs(e)).toBe('r.div(() => r.var(data, "a"), () => r.lit(0))');
  });

  it("emitted TS, executed, matches every vector", () => {
    for (const v of vectors) {
      const fn = new Function("r", "data", `return ${emitTs(v.expr)};`) as (
        rr: typeof r,
        d: Record<string, unknown>,
      ) => unknown;
      expect(fn(r, v.data)).toEqual(v.expect);
    }
  });
});
