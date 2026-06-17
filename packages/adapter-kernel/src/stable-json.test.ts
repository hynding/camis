import { describe, expect, it } from "vitest";
import { stableJson } from "./stable-json";

describe("stableJson", () => {
  it("preserves insertion order (does not sort keys)", () => {
    expect(stableJson({ b: 1, a: 2 })).toBe('{\n  "b": 1,\n  "a": 2\n}\n');
  });

  it("2-space indents nested objects and ends with a newline", () => {
    expect(stableJson({ x: { y: 1 } })).toBe('{\n  "x": {\n    "y": 1\n  }\n}\n');
  });

  it("is deterministic for the same input", () => {
    const v = { type: "string", required: true };
    expect(stableJson(v)).toBe(stableJson(v));
  });
});
