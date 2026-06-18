import { describe, expect, it } from "vitest";
import { contentType, irDocument } from "./document";

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

describe("document hooks", () => {
  const base = {
    version: 1,
    components: [],
    contentTypes: [
      { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
    ],
  };
  it("accepts a document with a valid hook", () => {
    expect(
      irDocument.safeParse({
        ...base,
        hooks: [
          {
            name: "TransformTitle",
            trigger: "onPublish",
            contentType: "Article",
            input: [{ name: "title", type: "string" }],
            output: [{ name: "title", type: "string" }],
          },
        ],
      }).success,
    ).toBe(true);
  });
  it("accepts a document with no hooks key (backward compatible)", () => {
    expect(irDocument.safeParse(base).success).toBe(true);
  });
  it("rejects a hook referencing an unknown content type", () => {
    expect(
      irDocument.safeParse({
        ...base,
        hooks: [
          {
            name: "H",
            trigger: "onPublish",
            contentType: "Ghost",
            input: [{ name: "t", type: "string" }],
            output: [{ name: "t", type: "string" }],
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects duplicate hook names", () => {
    const h = {
      name: "TransformTitle",
      trigger: "onPublish",
      contentType: "Article",
      input: [{ name: "title", type: "string" }],
      output: [{ name: "title", type: "string" }],
    };
    expect(irDocument.safeParse({ ...base, hooks: [h, h] }).success).toBe(false);
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
