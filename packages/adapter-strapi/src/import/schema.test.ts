import { describe, expect, it } from "vitest";
import { contentType as contentTypeSchema } from "@camis/ir-schema";
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
    expect(component).toEqual({
      name: "SeoMeta",
      names: { collection: "components_shared_seo_metas" },
      fields: [{ type: "string", name: "metaTitle" }],
    });
  });

  it("also captures the folder as names.group when given", () => {
    const schema = {
      collectionName: "components_finance_money",
      info: { displayName: "Money" },
      options: {},
      attributes: { minor: { type: "biginteger" } },
    };
    const { component } = irComponent("Money", schema, "finance");
    expect(component.names).toEqual({
      collection: "components_finance_money",
      group: "finance",
    });
  });
});

// A schema.json may omit collectionName (Strapi derives the table itself). "" is not a physical
// name, and `Component.names.collection` / `ContentType.names.collection` now reject it — so the
// importer must leave the key out rather than carry an empty string into the IR.
describe("irContentType with no collectionName", () => {
  const schema = {
    kind: "collectionType",
    info: { singularName: "article", pluralName: "articles", displayName: "Article" },
    attributes: { title: { type: "string", required: true } },
  };

  it("omits names.collection instead of setting it to an empty string", () => {
    const { contentType } = irContentType(schema);
    expect(contentType.names).toEqual({ display: "Article", plural: "Articles" });
    expect(contentType.names && "collection" in contentType.names).toBe(false);
  });

  it("still parses as a valid IR content type", () => {
    const { contentType } = irContentType(schema);
    expect(contentTypeSchema.safeParse(contentType).success).toBe(true);
  });
});
