import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { filamentNames, snakeColumn } from "./names";

const ct = (name: string, plural?: string): ContentType =>
  ({
    name,
    kind: "collection",
    fields: [],
    ...(plural ? { names: { plural } } : {}),
  }) as ContentType;

describe("filamentNames", () => {
  it("derives model/table/resource names for a simple type", () => {
    expect(filamentNames(ct("Article"))).toEqual({
      model: "Article",
      table: "articles",
      resourceDir: "Articles",
      resourceClass: "ArticleResource",
      formClass: "ArticleForm",
      tableClass: "ArticlesTable",
    });
  });
  it("handles multi-word names", () => {
    const n = filamentNames(ct("BlogPost"));
    expect(n.model).toBe("BlogPost");
    expect(n.table).toBe("blog_posts");
    expect(n.resourceClass).toBe("BlogPostResource");
  });
  // Strapi's starter names its site-wide single type "global", a word PHP keeps for itself.
  it("suffixes a model whose name PHP reserves, keeping its resource's name", () => {
    const n = filamentNames(ct("Global"));
    expect(n.model).toBe("GlobalModel");
    expect(n.table).toBe("globals");
    expect(n.resourceClass).toBe("GlobalResource");
    expect(filamentNames(ct("List")).model).toBe("ListModel");
    expect(filamentNames(ct("Listing")).model).toBe("Listing");
  });
  it("honors an explicit IR plural override", () => {
    expect(filamentNames(ct("Category", "Categories")).table).toBe("categories");
  });
});

describe("snakeColumn", () => {
  it("snake-cases field names", () => {
    expect(snakeColumn("publishedAt")).toBe("published_at");
    expect(snakeColumn("title")).toBe("title");
  });
});
