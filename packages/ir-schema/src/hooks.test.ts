import { describe, expect, it } from "vitest";
import { hook } from "./hooks";

describe("hook schema", () => {
  it("accepts a typed onPublish hook", () => {
    const r = hook.safeParse({
      name: "TransformTitle",
      trigger: "onPublish",
      contentType: "Article",
      input: [{ name: "title", type: "string" }],
      output: [{ name: "title", type: "string" }],
    });
    expect(r.success).toBe(true);
  });
  it("rejects a non-scalar shape type", () => {
    expect(
      hook.safeParse({
        name: "H",
        trigger: "onPublish",
        contentType: "Article",
        input: [{ name: "x", type: "relation" }],
        output: [{ name: "x", type: "string" }],
      }).success,
    ).toBe(false);
  });
  it("rejects an unknown trigger and empty shapes", () => {
    expect(
      hook.safeParse({
        name: "H",
        trigger: "onDelete",
        contentType: "Article",
        input: [{ name: "x", type: "string" }],
        output: [{ name: "x", type: "string" }],
      }).success,
    ).toBe(false);
    expect(
      hook.safeParse({
        name: "H",
        trigger: "onPublish",
        contentType: "Article",
        input: [],
        output: [{ name: "x", type: "string" }],
      }).success,
    ).toBe(false);
  });
});
