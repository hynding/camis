import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { evaluate } from "./evaluate";

describe("evaluate", () => {
  it("evaluates a nested expression against data", () => {
    const e: Expression = {
      kind: "and",
      args: [
        {
          kind: "eq",
          left: { kind: "var", name: "status" },
          right: { kind: "lit", value: "published" },
        },
        {
          kind: "gt",
          left: { kind: "var", name: "rank" },
          right: { kind: "lit", value: 3 },
        },
      ],
    };
    expect(evaluate(e, { status: "published", rank: 5 })).toEqual({
      ok: true,
      value: true,
    });
    expect(evaluate(e, { status: "draft", rank: 5 })).toEqual({
      ok: true,
      value: false,
    });
  });
  it("propagates div by zero", () => {
    const e: Expression = {
      kind: "div",
      left: { kind: "lit", value: 1 },
      right: { kind: "lit", value: 0 },
    };
    expect(evaluate(e, {})).toEqual({ ok: false, error: "DIV_BY_ZERO" });
  });
});
