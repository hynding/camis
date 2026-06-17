import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { validateInvariants } from "./invariants";

const codes = (doc: IrDocument) => validateInvariants(doc).map((e) => e.code);

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
