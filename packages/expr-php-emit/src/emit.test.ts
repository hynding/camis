import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { emitPhp } from "./emit";

describe("emitPhp", () => {
  it("emits a runtime-call PHP expression with arrow-fn thunks", () => {
    const e: Expression = {
      kind: "div",
      left: { kind: "var", name: "a" },
      right: { kind: "lit", value: 0 },
    };
    expect(emitPhp(e)).toBe('Ring1::div(fn() => Ring1::var($data, "a"), fn() => Ring1::lit(0))');
  });
  it("emits string, null, boolean literals", () => {
    expect(emitPhp({ kind: "lit", value: "x" })).toBe('Ring1::lit("x")');
    expect(emitPhp({ kind: "lit", value: null })).toBe("Ring1::lit(null)");
    expect(emitPhp({ kind: "lit", value: true })).toBe("Ring1::lit(true)");
    expect(emitPhp({ kind: "lit", value: false })).toBe("Ring1::lit(false)");
  });
  it("emits and/or/not/call", () => {
    expect(
      emitPhp({
        kind: "and",
        args: [
          { kind: "lit", value: true },
          { kind: "lit", value: false },
        ],
      }),
    ).toBe("Ring1::and(fn() => Ring1::lit(true), fn() => Ring1::lit(false))");
    expect(
      emitPhp({
        kind: "or",
        args: [
          { kind: "lit", value: true },
          { kind: "lit", value: false },
        ],
      }),
    ).toBe("Ring1::or(fn() => Ring1::lit(true), fn() => Ring1::lit(false))");
    expect(emitPhp({ kind: "not", arg: { kind: "lit", value: true } })).toBe(
      "Ring1::not(fn() => Ring1::lit(true))",
    );
    expect(emitPhp({ kind: "call", fn: "isNull", args: [{ kind: "lit", value: null }] })).toBe(
      "Ring1::isNull(fn() => Ring1::lit(null))",
    );
    expect(
      emitPhp({
        kind: "call",
        fn: "coalesce",
        args: [
          { kind: "var", name: "a" },
          { kind: "lit", value: 0 },
        ],
      }),
    ).toBe('Ring1::coalesce(fn() => Ring1::var($data, "a"), fn() => Ring1::lit(0))');
  });
});
