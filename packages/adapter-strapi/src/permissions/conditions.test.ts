import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { evaluate, r } from "@camis/expr-ts";
import { emitConditionsModule, handlerBody } from "./conditions";

const pred: Expression = {
  kind: "eq",
  left: { kind: "var", name: "user.role" },
  right: { kind: "lit", value: "editor" },
};

describe("conditions module", () => {
  it("is self-contained and registers each named condition", () => {
    const src = emitConditionsModule([{ name: "camis-cond-abcd1234", predicate: pred }]);
    expect(src).not.toContain("@camis/expr");
    expect(src).toContain("export const r");
    expect(src).toContain('name: "camis-cond-abcd1234"');
    expect(src).toContain('plugin: "admin"');
  });
  it("handler logic matches Ring-1 evaluate through the fail-closed mapping", () => {
    const data = { "user.role": "editor" } as Record<string, unknown>;
    const run = new Function("r", "data", "return " + handlerBody(pred)) as (
      rt: unknown,
      d: unknown,
    ) => { ok: boolean; value?: unknown };
    const result = run(r, data);
    const expected = evaluate(pred, data as never);
    expect(result).toEqual(expected);
    const denies = evaluate(pred, { "user.role": "viewer" } as never);
    expect(denies).toEqual({ ok: true, value: false });
  });
});
