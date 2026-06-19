import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { conditionKey, emitConditionsFile, fieldRuleKey, ring1RuntimeFile } from "./ring1";

const cond: Expression = {
  kind: "eq",
  left: { kind: "var", name: "record.title" },
  right: { kind: "lit", value: "x" },
};

describe("ring1 emission", () => {
  it("builds deterministic keys", () => {
    expect(conditionKey("Editor", "Article", "read")).toBe("c__Editor__Article__read");
    expect(fieldRuleKey("Editor", "Article", "secretNotes", "read")).toBe(
      "f__Editor__Article__secretNotes__read",
    );
  });
  it("emits a named condition function over the r runtime", () => {
    const file = emitConditionsFile([{ key: "c__Editor__Article__read", expr: cond }]);
    expect(file).toContain('import { r, type EvalResult, type Value } from "../ring1/runtime";');
    expect(file).toContain(
      "export const c__Editor__Article__read = (data: Record<string, Value>): EvalResult =>",
    );
    expect(file).toContain("r.eq(");
  });
  it("vendors the conformance runtime (exports r + Value)", () => {
    const rt = ring1RuntimeFile();
    expect(rt).toContain("export const r");
    expect(rt).toContain("export type Value");
  });
});
