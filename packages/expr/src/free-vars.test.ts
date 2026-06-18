import { describe, expect, it } from "vitest";
import { freeVars } from "./free-vars";
import type { Expression } from "./ast";

describe("freeVars", () => {
  it("returns distinct var names, sorted", () => {
    const e: Expression = {
      kind: "and",
      args: [
        {
          kind: "eq",
          left: { kind: "var", name: "user.role" },
          right: { kind: "lit", value: "editor" },
        },
        { kind: "not", arg: { kind: "var", name: "user.active" } },
        { kind: "var", name: "user.role" },
      ],
    };
    expect(freeVars(e)).toEqual(["user.active", "user.role"]);
  });
  it("is empty for a literal-only expression", () => {
    expect(freeVars({ kind: "lit", value: 1 })).toEqual([]);
  });
  it("walks call and arithmetic operands", () => {
    const e: Expression = {
      kind: "call",
      fn: "coalesce",
      args: [{ kind: "add", left: { kind: "var", name: "a" }, right: { kind: "var", name: "b" } }],
    };
    expect(freeVars(e)).toEqual(["a", "b"]);
  });
});
