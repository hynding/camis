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
  });
});
