import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { conditionName } from "./condition-name";

const a: Expression = {
  kind: "eq",
  left: { kind: "var", name: "user.role" },
  right: { kind: "lit", value: "editor" },
};
const b: Expression = {
  kind: "eq",
  left: { kind: "var", name: "user.role" },
  right: { kind: "lit", value: "admin" },
};

describe("conditionName", () => {
  it("is stable and starts with the camis prefix", () => {
    expect(conditionName(a)).toBe(conditionName(a));
    expect(conditionName(a)).toMatch(/^camis-cond-[0-9a-f]{8}$/);
  });
  it("differs for different predicates", () => {
    expect(conditionName(a)).not.toBe(conditionName(b));
  });
});
