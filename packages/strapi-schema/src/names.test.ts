import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { strapiNames } from "./names";

const ct = (name: string, names?: ContentType["names"]): ContentType => ({
  name,
  kind: "collection",
  fields: [],
  ...(names ? { names } : {}),
});

describe("strapiNames", () => {
  it("projects a single-word PascalCase name", () => {
    expect(
      strapiNames(
        ct("Article", {
          plural: "Articles",
          display: "Article",
          collection: "articles",
        }),
      ),
    ).toEqual({
      singularName: "article",
      pluralName: "articles",
      collectionName: "articles",
      displayName: "Article",
      uid: "api::article.article",
    });
  });

  it("kebab-cases multi-word names", () => {
    const n = strapiNames(
      ct("BlogPost", {
        plural: "BlogPosts",
        display: "Blog Post",
        collection: "blog_posts",
      }),
    );
    expect(n.singularName).toBe("blog-post");
    expect(n.pluralName).toBe("blog-posts");
    expect(n.uid).toBe("api::blog-post.blog-post");
  });
});

// One display name per component, for the schema, the importer and the admin alike.
describe("componentDisplayName", () => {
  it("is the component's own, or its name humanized", async () => {
    const { componentDisplayName } = await import("./names");
    expect(componentDisplayName({ name: "MenuItem", fields: [] })).toBe("Menu Item");
    expect(componentDisplayName({ name: "MenuItem", names: { display: "Link" }, fields: [] })).toBe(
      "Link",
    );
  });
});
