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
