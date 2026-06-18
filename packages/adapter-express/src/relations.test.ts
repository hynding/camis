import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { resolveRelations } from "./relations";

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
    { name: "Author", kind: "collection", fields: [] },
  ],
  components: [],
};

describe("resolveRelations (express, sqlite)", () => {
  const r = resolveRelations(doc, "sqlite");
  it("owner gets an FK column referencing the target id", () => {
    expect(
      r.fkColumns
        .get("Article")!
        .some((c) => c.includes("author_id: integer('author_id').references(() => authors.id)")),
    ).toBe(true);
  });
  it("emits relations() blocks for owner (one) and target (many)", () => {
    expect(r.relationBlocks.get("Article")!.some((b) => b.includes("one(authors"))).toBe(true);
    expect(r.relationBlocks.get("Author")!.some((b) => b.includes("many(articles"))).toBe(true);
  });
});
