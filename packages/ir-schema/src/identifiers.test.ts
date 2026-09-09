import { describe, expect, it } from "vitest";
import { collectionName, fieldName, typeName } from "./identifiers";

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

// A collection/group name is a physical database identifier: it becomes a table name, a component
// category directory and part of Strapi's `<group>.<name>` component uid. Anything outside
// lowercase alphanumerics with `_`/`-` separators either cannot be a table name or silently
// renames itself somewhere downstream.
describe("collectionName (lowercase identifier)", () => {
  it.each([
    "notes",
    "activity-sessions",
    "components_finance_money",
    "finance",
    "a",
    "v2",
    "1st_things",
  ])("accepts %s", (n) => {
    expect(collectionName.safeParse(n).success).toBe(true);
  });
  it.each(["Notes", "activity sessions", "_leading", "-leading", "notes;drop", "notes.money", ""])(
    "rejects %s",
    (n) => {
      expect(collectionName.safeParse(n).success).toBe(false);
    },
  );
});
