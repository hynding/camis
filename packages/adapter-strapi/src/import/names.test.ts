import { describe, expect, it } from "vitest";
import { irName } from "./names";

describe("irName", () => {
  it("PascalCases a kebab singular", () => {
    expect(irName("article")).toBe("Article");
    expect(irName("blog-post")).toBe("BlogPost");
    expect(irName("seo-meta")).toBe("SeoMeta");
  });
});
