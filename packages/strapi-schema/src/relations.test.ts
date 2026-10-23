import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { dual, synthesizedInverses } from "./relations";

describe("dual", () => {
  it("pairs relation kinds", () => {
    expect(dual("manyToOne")).toBe("oneToMany");
    expect(dual("oneToMany")).toBe("manyToOne");
    expect(dual("oneToOne")).toBe("oneToOne");
    expect(dual("manyToMany")).toBe("manyToMany");
  });
});

describe("synthesizedInverses", () => {
  it("produces a mappedBy attribute on the target type for an owner relation with inverse", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Article",
          kind: "collection",
          fields: [
            {
              type: "relation",
              name: "author",
              relationKind: "manyToOne",
              target: "Author",
              inverse: "articles",
            },
          ],
        },
        { name: "Author", kind: "collection", fields: [{ type: "string", name: "name" }] },
      ],
      components: [],
    };
    const inv = synthesizedInverses(doc);
    expect(inv.get("Author")).toEqual({
      articles: {
        type: "relation",
        relation: "oneToMany",
        target: "api::article.article",
        mappedBy: "author",
      },
    });
    expect(inv.get("Article")).toBeUndefined();
  });
});
