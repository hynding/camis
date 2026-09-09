import { describe, expect, it } from "vitest";
import { component, contentType, irDocument } from "./document";

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

describe("builtin content types", () => {
  it("accepts builtin: 'user' on a content type and preserves it", () => {
    const r = contentType.safeParse({
      name: "User",
      kind: "collection",
      builtin: "user",
      fields: [{ type: "string", name: "username" }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.builtin).toBe("user");
  });

  it("rejects unknown builtin kinds", () => {
    const r = contentType.safeParse({
      name: "Team",
      kind: "collection",
      builtin: "team",
      fields: [{ type: "string", name: "name" }],
    });
    expect(r.success).toBe(false);
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

describe("component.names", () => {
  it("accepts a component with names.collection and names.group", () => {
    const r = component.safeParse({
      name: "Money",
      fields: [{ type: "bigInteger", name: "minor" }],
      names: { collection: "components_finance_money", group: "finance" },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.names).toEqual({ collection: "components_finance_money", group: "finance" });
    }
  });

  it("accepts a component with no names (backward compatible)", () => {
    const r = component.safeParse({
      name: "Money",
      fields: [{ type: "bigInteger", name: "minor" }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.names).toBeUndefined();
  });
});

describe("options.upsertBy", () => {
  it("accepts upsertBy naming a field", () => {
    const r = contentType.safeParse({
      name: "Note",
      kind: "collection",
      options: { upsertBy: "recordId" },
      fields: [{ type: "string", name: "recordId", required: true, unique: true }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.options?.upsertBy).toBe("recordId");
  });
});
