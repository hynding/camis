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

  it("keys the inverse and its mappedBy by their API names", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "RelationLocale",
          kind: "collection",
          fields: [
            {
              type: "relation",
              name: "categories",
              relationKind: "manyToMany",
              target: "Category",
              inverse: "relationLocales",
              inverseNames: { api: "relation_locales" },
            },
            {
              type: "relation",
              name: "mainCategory",
              names: { api: "main_category" },
              relationKind: "manyToOne",
              target: "Category",
              inverse: "mainLocales",
            },
          ],
        },
        { name: "Category", kind: "collection", fields: [{ type: "string", name: "name" }] },
      ],
      components: [],
    };
    expect(synthesizedInverses(doc).get("Category")).toEqual({
      relation_locales: {
        type: "relation",
        relation: "manyToMany",
        target: "api::relation-locale.relation-locale",
        mappedBy: "categories",
      },
      mainLocales: {
        type: "relation",
        relation: "oneToMany",
        target: "api::relation-locale.relation-locale",
        mappedBy: "main_category",
      },
    });
  });
});
