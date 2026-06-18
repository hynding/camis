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
        {
          type: "relation",
          name: "tags",
          relationKind: "manyToMany",
          target: "Tag",
          inverse: "articles",
        },
      ],
    },
    { name: "Author", kind: "collection", fields: [] },
    { name: "Tag", kind: "collection", fields: [] },
  ],
  components: [],
};

describe("resolveRelations", () => {
  const r = resolveRelations(doc);
  it("emits an explicit belongsTo on the owner and FK column", () => {
    expect(
      r.methods
        .get("Article")!
        .some((m) => m.php.includes("belongsTo(Author::class, 'author_id')")),
    ).toBe(true);
    expect(
      r.fkColumns
        .get("Article")!
        .some((c) => c === "$table->foreignId('author_id')->nullable()->constrained('authors')"),
    ).toBe(true);
    expect(
      r.formFields
        .get("Article")!
        .some((s) => s.includes("Select::make('author_id')->relationship(name: 'author'")),
    ).toBe(true);
  });
  it("synthesizes a hasMany inverse on the target", () => {
    expect(
      r.methods.get("Author")!.some((m) => m.php.includes("hasMany(Article::class, 'author_id')")),
    ).toBe(true);
  });
  it("emits a deduped pivot for manyToMany with explicit keys on both sides", () => {
    expect(r.pivots.map((p) => p.table)).toEqual(["article_tag"]);
    expect(
      r.methods
        .get("Article")!
        .some((m) =>
          m.php.includes("belongsToMany(Tag::class, 'article_tag', 'article_id', 'tag_id')"),
        ),
    ).toBe(true);
    expect(
      r.methods
        .get("Tag")!
        .some((m) =>
          m.php.includes("belongsToMany(Article::class, 'article_tag', 'tag_id', 'article_id')"),
        ),
    ).toBe(true);
  });
});
