import { describe, expect, it } from "vitest";
import { tsRuntimeSource } from "./runtime-source";

describe("tsRuntimeSource", () => {
  const src = tsRuntimeSource();
  it("is self-contained: no @camis/expr import, exports r", () => {
    expect(src).not.toContain("@camis/expr");
    expect(src).toContain("export const r");
    expect(src).toContain("const ok = (value: Value)");
  });
  it("is stable across calls", () => {
    expect(tsRuntimeSource()).toBe(tsRuntimeSource());
  });
  it("exports the embeddable Value and EvalResult types", () => {
    expect(src).toContain("export type Value =");
    expect(src).toContain("export type EvalResult =");
  });
  it("still defines the r runtime", () => {
    expect(src).toContain("export const r");
  });
});
