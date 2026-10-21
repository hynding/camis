import { describe, expect, it } from "vitest";
import { routePath } from "./names";

describe("strapi-api names", () => {
  it("routePath is the kebab plural from names.plural", () => {
    expect(
      routePath({
        name: "ActivitySession",
        kind: "collection",
        names: { plural: "ActivitySessions" },
        fields: [],
      }),
    ).toBe("activity-sessions");
  });
  it("routePath falls back to pluralizing the type name", () => {
    expect(routePath({ name: "Note", kind: "collection", fields: [] })).toBe("notes");
    expect(routePath({ name: "Category", kind: "collection", fields: [] })).toBe("categories");
  });
});
