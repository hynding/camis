import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { validateInvariants } from "./invariants";

const docWith = (articleFields: unknown[]): IrDocument =>
  ({
    version: 1,
    contentTypes: [{ name: "Article", kind: "collection", fields: articleFields }],
    components: [],
  }) as IrDocument;

const codes = (doc: IrDocument) => validateInvariants(doc).map((e) => e.code);

describe("the builtin file type", () => {
  const withFile = (file: object, extra: object[] = []): IrDocument =>
    ({
      version: 1,
      contentTypes: [
        { name: "File", kind: "collection", builtin: "file", fields: [], ...file },
        ...extra,
      ],
      components: [],
    }) as IrDocument;

  it("accepts one with no fields", () => {
    expect(codes(withFile({}))).toEqual([]);
  });

  // Its fields are the media library's own (name, url, formats, …), fixed by every target.
  it("declares no fields of its own", () => {
    const errors = validateInvariants(withFile({ fields: [{ type: "string", name: "label" }] }));
    expect(errors).toEqual([
      expect.objectContaining({ code: "builtin_file_fields", location: { contentType: "File" } }),
    ]);
  });

  it("is declared once", () => {
    const second = { name: "Asset", kind: "collection", builtin: "file", fields: [] };
    expect(codes(withFile({}, [second]))).toEqual(["duplicate_builtin_file"]);
  });

  // A file is linked through a media field, which says how many and of which kinds.
  it("is not a relation target", () => {
    const post = {
      name: "Post",
      kind: "collection",
      fields: [{ type: "relation", name: "image", relationKind: "manyToOne", target: "File" }],
    };
    expect(validateInvariants(withFile({}, [post]))).toEqual([
      expect.objectContaining({
        code: "relation_to_builtin_file",
        location: { contentType: "Post", field: "image" },
      }),
    ]);
  });
});

describe("reference invariants", () => {
  it("flags an unknown relation target (C1)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Article",
          kind: "collection",
          fields: [
            { type: "relation", name: "author", relationKind: "manyToOne", target: "Ghost" },
          ],
        },
      ],
      components: [],
    };
    expect(codes(doc)).toContain("unknown_relation_target");
  });

  it("allows a self relation", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Category",
          kind: "collection",
          fields: [
            { type: "relation", name: "parent", relationKind: "manyToOne", target: "Category" },
          ],
        },
      ],
      components: [],
    };
    expect(codes(doc)).not.toContain("unknown_relation_target");
  });

  it("flags an unknown component reference (C2)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Page",
          kind: "collection",
          fields: [{ type: "component", name: "seo", component: "Ghost", repeatable: false }],
        },
      ],
      components: [],
    };
    expect(codes(doc)).toContain("unknown_component_ref");
  });

  it("flags an unknown component in a dynamic zone (C2)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Page",
          kind: "collection",
          fields: [{ type: "dynamicZone", name: "blocks", components: ["Ghost"] }],
        },
      ],
      components: [],
    };
    expect(codes(doc)).toContain("unknown_component_ref");
  });
});

describe("uniqueness, acyclic, inverse collision", () => {
  it("flags duplicate content type names (C3)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        { name: "Article", kind: "collection", fields: [] },
        { name: "Article", kind: "single", fields: [] },
      ],
      components: [],
    };
    expect(codes(doc)).toContain("duplicate_content_type_name");
  });

  it("flags duplicate component names (C3)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [],
      components: [
        { name: "Seo", fields: [{ type: "string", name: "metaTitle" }] },
        { name: "Seo", fields: [{ type: "string", name: "metaDescription" }] },
      ],
    };
    expect(codes(doc)).toContain("duplicate_component_name");
  });

  it("flags a cyclic component reference (C4)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [],
      components: [
        {
          name: "A",
          fields: [{ type: "component", name: "b", component: "B", repeatable: false }],
        },
        {
          name: "B",
          fields: [{ type: "component", name: "a", component: "A", repeatable: false }],
        },
      ],
    };
    expect(codes(doc)).toContain("cyclic_component_reference");
  });

  it("flags an inverse field that collides on the target (C5)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Article",
          kind: "collection",
          fields: [
            {
              type: "relation",
              name: "author",
              relationKind: "manyToOne",
              target: "User",
              inverse: "name",
            },
          ],
        },
        { name: "User", kind: "collection", fields: [{ type: "string", name: "name" }] },
      ],
      components: [],
    };
    expect(codes(doc)).toContain("inverse_field_collision");
  });
});

describe("ai invariants", () => {
  it("accepts an ai field whose placeholders name existing scalar fields", () => {
    const errors = validateInvariants(
      docWith([
        { type: "text", name: "body" },
        { type: "text", name: "summary", ai: { prompt: "Sum {{body}}", trigger: "onCreate" } },
      ]),
    );
    expect(errors.filter((e) => e.code === "unknown_ai_source")).toHaveLength(0);
  });
  it("rejects an unknown placeholder", () => {
    const errors = validateInvariants(
      docWith([
        { type: "text", name: "summary", ai: { prompt: "Sum {{missing}}", trigger: "onCreate" } },
      ]),
    );
    expect(
      errors.some((e) => e.code === "unknown_ai_source" && e.location.field === "summary"),
    ).toBe(true);
  });
  it("rejects a placeholder naming a relation/the field itself", () => {
    const errors = validateInvariants(
      docWith([
        { type: "relation", name: "author", relationKind: "manyToOne", target: "Article" },
        {
          type: "text",
          name: "summary",
          ai: { prompt: "{{author}} {{summary}}", trigger: "onCreate" },
        },
      ]),
    );
    expect(errors.filter((e) => e.code === "unknown_ai_source")).toHaveLength(2);
  });
  it("rejects ai + computed on the same field", () => {
    const errors = validateInvariants(
      docWith([
        {
          type: "text",
          name: "summary",
          ai: { prompt: "x", trigger: "onCreate" },
          computed: { kind: "lit", value: "y" },
        },
      ]),
    );
    expect(
      errors.some((e) => e.code === "ai_computed_conflict" && e.location.field === "summary"),
    ).toBe(true);
  });
});

describe("upsertBy invariants", () => {
  const doc = (options: object, fields: object[]) => ({
    version: 1 as const,
    contentTypes: [{ name: "Note", kind: "collection" as const, options, fields }],
    components: [],
  });

  it("accepts upsertBy on a unique scalar field", () => {
    const errors = validateInvariants(
      doc({ upsertBy: "recordId" }, [
        { type: "string", name: "recordId", required: true, unique: true },
      ]) as never,
    );
    expect(errors).toEqual([]);
  });

  it("rejects upsertBy naming an absent field", () => {
    const errors = validateInvariants(
      doc({ upsertBy: "missing" }, [{ type: "string", name: "recordId" }]) as never,
    );
    expect(errors.map((e) => e.code)).toEqual(["unknown_upsert_field"]);
  });

  it("rejects upsertBy naming a non-unique field", () => {
    const errors = validateInvariants(
      doc({ upsertBy: "recordId" }, [{ type: "string", name: "recordId" }]) as never,
    );
    expect(errors.map((e) => e.code)).toEqual(["non_unique_upsert_field"]);
  });

  it("rejects upsertBy naming a relation field", () => {
    const errors = validateInvariants(
      doc({ upsertBy: "owner" }, [
        { type: "string", name: "recordId" },
        { type: "relation", name: "owner", relationKind: "manyToOne", target: "Note" },
      ]) as never,
    );
    expect(errors.map((e) => e.code)).toEqual(["non_unique_upsert_field"]);
  });
});
