import { describe, expect, it } from "vitest";
import { irComponent, irContentType } from "./schema";

describe("irContentType", () => {
  it("reverses a content-type schema, dropping mappedBy inverse attrs", () => {
    const schema = {
      kind: "collectionType",
      collectionName: "articles",
      info: { singularName: "article", pluralName: "articles", displayName: "Article" },
      options: { draftAndPublish: true },
      pluginOptions: {},
      attributes: {
        title: { type: "string", required: true },
        author: {
          type: "relation",
          relation: "manyToOne",
          target: "api::author.author",
          inversedBy: "tags",
        },
      },
    };
    const { contentType, gaps } = irContentType(schema);
    expect(contentType).toEqual({
      name: "Article",
      kind: "collection",
      names: { display: "Article", plural: "Articles", collection: "articles" },
      options: { draftPublish: true },
      fields: [
        { type: "string", name: "title", required: true },
        {
          type: "relation",
          name: "author",
          relationKind: "manyToOne",
          target: "Author",
          inverse: "tags",
        },
      ],
    });
    expect(gaps).toEqual([]);
  });
});

describe("irComponent", () => {
  it("reverses a component json using the path-derived name", () => {
    const schema = {
      collectionName: "components_shared_seo_metas",
      info: { displayName: "Seo Meta" },
      options: {},
      attributes: { metaTitle: { type: "string" } },
    };
    const { component } = irComponent("SeoMeta", schema);
    expect(component).toEqual({ name: "SeoMeta", fields: [{ type: "string", name: "metaTitle" }] });
  });
});
