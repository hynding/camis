import { describe, expect, it } from "vitest";
import { validate } from "./validate";
import { validBlog } from "./__fixtures__/valid-blog";

describe("validate", () => {
  it("accepts the valid multi-type document and returns it normalized", () => {
    const r = validate(validBlog);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.contentTypes[0]!.names!.collection).toBe("articles");
  });

  it("collects structural and cross-graph errors together", () => {
    const r = validate({
      version: 1,
      contentTypes: [
        {
          name: "Article",
          kind: "collection",
          fields: [
            { type: "relation", name: "author", relationKind: "manyToOne", target: "Ghost" },
          ],
        },
      ],
      components: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.code === "unknown_relation_target")).toBe(true);
  });

  it("does not run invariants when structural parsing fails", () => {
    const r = validate({
      version: 1,
      contentTypes: [{ name: "article", kind: "collection", fields: [] }],
      components: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.every((e) => e.code === "invalid_identifier")).toBe(true);
  });
});
