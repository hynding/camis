import { describe, expect, it } from "vitest";
import { tsRuntimeSource } from "./runtime-source";

describe("tsRuntimeSource", () => {
  it("is self-contained: no @camis/expr import, exports r", () => {
    const src = tsRuntimeSource();
    expect(src).not.toContain("@camis/expr");
    expect(src).toContain("export const r");
    expect(src).toContain("const ok = (value: Value)");
  });
  it("is stable across calls", () => {
    expect(tsRuntimeSource()).toBe(tsRuntimeSource());
  });
});
