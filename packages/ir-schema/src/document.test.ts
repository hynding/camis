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

describe("field expression attachment points", () => {
  it("accepts a field with a validate/visibleWhen/computed expression", () => {
    const r = contentType.safeParse({
      name: "Article",
      kind: "collection",
      fields: [
        {
          type: "string",
          name: "slug",
          visibleWhen: {
            kind: "eq",
            left: { kind: "var", name: "status" },
            right: { kind: "lit", value: "published" },
          },
        },
      ],
    });
    expect(r.success).toBe(true);
  });
  it("rejects an ill-formed expression", () => {
    const r = contentType.safeParse({
      name: "Article",
      kind: "collection",
      fields: [{ type: "string", name: "slug", computed: { kind: "loop" } }],
    });
    expect(r.success).toBe(false);
  });
});
