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

describe("resolveRelations — oneToOne and oneToMany", () => {
  const doc2: IrDocument = {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          {
            type: "relation",
            name: "profile",
            relationKind: "oneToOne",
            target: "Profile",
            inverse: "article",
          },
        ],
      },
      {
        name: "Author",
        kind: "collection",
        fields: [
          {
            type: "relation",
            name: "posts",
            relationKind: "oneToMany",
            target: "Post",
            inverse: "writer",
          },
        ],
      },
      { name: "Profile", kind: "collection", fields: [] },
      { name: "Post", kind: "collection", fields: [] },
    ],
    components: [],
  };
  const r = resolveRelations(doc2);

  it("oneToOne: owner belongsTo with a unique nullable FK; inverse hasOne", () => {
    expect(
      r.methods
        .get("Article")!
        .some((m) => m.php.includes("belongsTo(Profile::class, 'profile_id')")),
    ).toBe(true);
    expect(r.fkColumns.get("Article")!).toContain(
      "$table->foreignId('profile_id')->nullable()->unique()->constrained('profiles')",
    );
    expect(
      r.methods.get("Profile")!.some((m) => m.php.includes("hasOne(Article::class, 'profile_id')")),
    ).toBe(true);
  });

  it("oneToMany: owner hasMany; FK injected on the target table; inverse belongsTo + Select on target", () => {
    expect(
      r.methods.get("Author")!.some((m) => m.php.includes("hasMany(Post::class, 'writer_id')")),
    ).toBe(true);
    expect(r.fkColumns.get("Post")!).toContain(
      "$table->foreignId('writer_id')->nullable()->constrained('authors')",
    );
    expect(
      r.methods.get("Post")!.some((m) => m.php.includes("belongsTo(Author::class, 'writer_id')")),
    ).toBe(true);
    expect(
      r.formFields
        .get("Post")!
        .some((s) => s.includes("Select::make('writer_id')->relationship(name: 'writer'")),
    ).toBe(true);
  });
});
