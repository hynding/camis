import { describe, expect, it } from "vitest";
import { humanize, pluralize, snakeCase } from "./inflect";

describe("inflect", () => {
  it("humanize splits PascalCase", () => {
    expect(humanize("BlogPost")).toBe("Blog Post");
    expect(humanize("Article")).toBe("Article");
  });

  it("snakeCase pluralizes and lowercases", () => {
    expect(snakeCase("BlogPost")).toBe("blog_post");
  });

  it("pluralize applies s/es/ies rules", () => {
    expect(pluralize("Article")).toBe("Articles");
    expect(pluralize("Box")).toBe("Boxes");
    expect(pluralize("Category")).toBe("Categories");
  });
});
