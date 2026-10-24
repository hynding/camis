import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { contentTypeSchema } from "./schema";

const article: ContentType = {
  name: "Article",
  kind: "collection",
  names: { plural: "Articles", display: "Article", collection: "articles" },
  fields: [{ type: "string", name: "title", required: true }],
  options: { draftPublish: true },
};

describe("contentTypeSchema", () => {
  it("builds a Strapi v5 collectionType schema", () => {
    expect(contentTypeSchema(article)).toEqual({
      kind: "collectionType",
      collectionName: "articles",
      info: { singularName: "article", pluralName: "articles", displayName: "Article" },
      options: { draftAndPublish: true },
      pluginOptions: {},
      attributes: { title: { type: "string", required: true } },
    });
  });

  it("omits draftAndPublish when draftPublish is false/absent", () => {
    const s = contentTypeSchema({ ...article, options: {} });
    expect(s.options).toEqual({});
  });

  it("maps a single kind to singleType", () => {
    const s = contentTypeSchema({ ...article, kind: "single" });
    expect(s.kind).toBe("singleType");
  });
});

describe("localized content types", () => {
  const localized: ContentType = {
    name: "Article",
    kind: "collection",
    names: { plural: "Articles", display: "Article", collection: "articles" },
    options: { localized: true },
    fields: [
      { type: "string", name: "title" },
      { type: "string", name: "code", localized: false },
      { type: "relation", name: "category", relationKind: "manyToOne", target: "Category" },
    ],
  };
  it("turn on the i18n plugin for the type and say per field whether it varies per locale", () => {
    const s = contentTypeSchema(localized);
    expect(s.pluginOptions).toEqual({ i18n: { localized: true } });
    expect(s.attributes).toEqual({
      title: { type: "string", pluginOptions: { i18n: { localized: true } } },
      code: { type: "string", pluginOptions: { i18n: { localized: false } } },
      category: { type: "relation", relation: "manyToOne", target: "api::category.category" },
    });
  });
});
