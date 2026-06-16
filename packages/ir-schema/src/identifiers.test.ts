import { describe, expect, it } from "vitest";
import { fieldName, typeName } from "./identifiers";

describe("typeName (PascalCase)", () => {
  it.each(["Article", "BlogPost", "A1"])("accepts %s", (n) => {
    expect(typeName.safeParse(n).success).toBe(true);
  });
  it.each(["article", "1Bad", "Blog Post", ""])("rejects %s", (n) => {
    expect(typeName.safeParse(n).success).toBe(false);
  });
});

describe("fieldName (camelCase)", () => {
  it.each(["title", "blogPost", "a1"])("accepts %s", (n) => {
    expect(fieldName.safeParse(n).success).toBe(true);
  });
  it.each(["Title", "1bad", "blog_post", ""])("rejects %s", (n) => {
    expect(fieldName.safeParse(n).success).toBe(false);
  });
});
