import { describe, expect, it } from "vitest";
import { mutations } from "./mutation";

describe("mutation schema", () => {
  it("parses the five op kinds", () => {
    const ops = [
      {
        op: "addContentType",
        contentType: {
          name: "Article",
          kind: "collection",
          fields: [{ type: "string", name: "title", required: true }],
        },
      },
      { op: "removeContentType", name: "Old" },
      { op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } },
      { op: "removeField", contentType: "Article", field: "draft" },
      { op: "renameField", contentType: "Article", from: "body", to: "content" },
    ];
    expect(mutations.safeParse(ops).success).toBe(true);
  });
  it("rejects an unknown op and a malformed field", () => {
    expect(mutations.safeParse([{ op: "frobnicate" }]).success).toBe(false);
    expect(
      mutations.safeParse([
        { op: "addField", contentType: "Article", field: { type: "nope", name: "x" } },
      ]).success,
    ).toBe(false);
  });
});
