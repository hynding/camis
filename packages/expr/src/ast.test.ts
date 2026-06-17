import { describe, expect, it } from "vitest";
import { expression } from "./ast";

describe("expression schema", () => {
  it("accepts a nested valid expression", () => {
    const e = {
      kind: "and",
      args: [
        {
          kind: "eq",
          left: { kind: "var", name: "status" },
          right: { kind: "lit", value: "published" },
        },
        { kind: "gt", left: { kind: "var", name: "rank" }, right: { kind: "lit", value: 3 } },
      ],
    };
    expect(expression.safeParse(e).success).toBe(true);
  });
  it("rejects a non-whitelisted node kind (purity guard)", () => {
    expect(expression.safeParse({ kind: "loop", body: { kind: "lit", value: 1 } }).success).toBe(
      false,
    );
    expect(
      expression.safeParse({ kind: "assign", name: "x", value: { kind: "lit", value: 1 } }).success,
    ).toBe(false);
  });
  it("rejects a non-whitelisted call fn", () => {
    expect(expression.safeParse({ kind: "call", fn: "exec", args: [] }).success).toBe(false);
  });
  it("rejects a non-finite number literal", () => {
    expect(expression.safeParse({ kind: "lit", value: Infinity }).success).toBe(false);
    expect(expression.safeParse({ kind: "lit", value: NaN }).success).toBe(false);
  });
  it("rejects isNull with the wrong arity", () => {
    expect(expression.safeParse({ kind: "call", fn: "isNull", args: [] }).success).toBe(false);
    expect(
      expression.safeParse({
        kind: "call",
        fn: "isNull",
        args: [
          { kind: "lit", value: 1 },
          { kind: "lit", value: 2 },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects coalesce with no arguments", () => {
    expect(expression.safeParse({ kind: "call", fn: "coalesce", args: [] }).success).toBe(false);
  });
  it("accepts isNull arity 1 and coalesce arity >=1", () => {
    expect(
      expression.safeParse({ kind: "call", fn: "isNull", args: [{ kind: "lit", value: null }] })
        .success,
    ).toBe(true);
    expect(
      expression.safeParse({ kind: "call", fn: "coalesce", args: [{ kind: "var", name: "a" }] })
        .success,
    ).toBe(true);
  });
});
