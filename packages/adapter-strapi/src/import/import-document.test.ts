import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { importDocument } from "./import-document";

const blog = {
  version: 1 as const,
  contentTypes: [
    {
      name: "Article",
      kind: "collection" as const,
      fields: [
        { type: "string" as const, name: "title", required: true },
        {
          type: "relation" as const,
          name: "author",
          relationKind: "manyToOne" as const,
          target: "Author",
          inverse: "articles",
        },
        { type: "component" as const, name: "seo", component: "SeoMeta", repeatable: false },
      ],
    },
    {
      name: "Author",
      kind: "collection" as const,
      fields: [{ type: "string" as const, name: "name" }],
    },
  ],
  components: [{ name: "SeoMeta", fields: [{ type: "string" as const, name: "metaTitle" }] }],
};

describe("importDocument", () => {
  it("reads only declarative schema files and reconstructs IR", () => {
    const files = strapiAdapter.generate(blog, { projectName: "blog" }).files;
    const { document, gaps } = importDocument(files);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(document.value.contentTypes.map((c) => c.name).sort()).toEqual(["Article", "Author"]);
    expect(document.value.components.map((c) => c.name)).toEqual(["SeoMeta"]);
    const author = document.value.contentTypes.find((c) => c.name === "Author")!;
    expect(author.fields.map((f) => f.name)).toEqual(["name"]);
    expect(gaps.gaps).toEqual([]);
  });

  it("ignores generated .ts and skeleton files", () => {
    const files = [
      { path: "package.json", content: "{}" },
      { path: "src/api/article/controllers/article.ts", content: "x" },
      {
        path: "src/api/article/content-types/article/schema.json",
        content: JSON.stringify({
          kind: "collectionType",
          collectionName: "articles",
          info: { singularName: "article", pluralName: "articles", displayName: "Article" },
          options: {},
          pluginOptions: {},
          attributes: { title: { type: "string" } },
        }),
      },
    ];
    const { document } = importDocument(files);
    expect(document.ok).toBe(true);
    if (!document.ok) return;
    expect(document.value.contentTypes).toHaveLength(1);
  });
});
