import { describe, expect, it } from "vitest";
import { contentType } from "./document";

const ct = (fields: unknown[]) =>
  contentType.safeParse({ name: "Article", kind: "collection", fields });

describe("contentType node refinements", () => {
  it("accepts a valid type", () => {
    expect(ct([{ type: "string", name: "title" }]).success).toBe(true);
  });

  it("rejects duplicate field names (S5)", () => {
    expect(
      ct([
        { type: "string", name: "title" },
        { type: "text", name: "title" },
      ]).success,
    ).toBe(false);
  });

  it("rejects the reserved field name id (S8)", () => {
    expect(ct([{ type: "string", name: "id" }]).success).toBe(false);
  });

  it("accepts uid.targetField pointing at a sibling (S10)", () => {
    expect(
      ct([
        { type: "string", name: "title" },
        { type: "uid", name: "slug", targetField: "title" },
      ]).success,
    ).toBe(true);
  });

  it("rejects uid.targetField with no such sibling (S10)", () => {
    expect(ct([{ type: "uid", name: "slug", targetField: "missing" }]).success).toBe(false);
  });
});
