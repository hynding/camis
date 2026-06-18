import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { expressNames, snakeColumn } from "./names";

const ct = (name: string, plural?: string): ContentType =>
  ({
    name,
    kind: "collection",
    fields: [],
    ...(plural ? { names: { plural } } : {}),
  }) as ContentType;

describe("names", () => {
  it("derives table + route names", () => {
    expect(expressNames(ct("Article"))).toEqual({ table: "articles", routeBase: "articles" });
    expect(expressNames(ct("BlogPost")).table).toBe("blog_posts");
  });
  it("honors an explicit plural", () => {
    expect(expressNames(ct("Category", "Categories")).table).toBe("categories");
  });
  it("snakeColumn snake-cases field names", () => {
    expect(snakeColumn("publishedAt")).toBe("published_at");
  });
});
