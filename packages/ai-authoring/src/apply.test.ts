import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { applyMutations } from "./apply";
import type { Mutation } from "./mutation";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [{ type: "string", name: "title", required: true }],
    },
  ],
  components: [],
} as IrDocument;

describe("applyMutations", () => {
  it("adds a field to an existing content type", () => {
    const ops: Mutation[] = [
      { op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } },
    ];
    const r = applyMutations(doc, ops);
    expect(r.errors).toHaveLength(0);
    expect(r.document.contentTypes[0]!.fields.map((f) => f.name)).toEqual(["title", "published"]);
  });
  it("does not mutate the input document (pure)", () => {
    applyMutations(doc, [
      { op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } },
    ]);
    expect(doc.contentTypes[0]!.fields).toHaveLength(1);
  });
  it("reports an applicability error for an op on a missing content type", () => {
    const r = applyMutations(doc, [
      { op: "addField", contentType: "Ghost", field: { type: "boolean", name: "x" } },
    ]);
    expect(
      r.errors.some(
        (e) => e.code === "inapplicable_mutation" && e.location.contentType === "Ghost",
      ),
    ).toBe(true);
    expect(r.document.contentTypes).toHaveLength(1);
  });
  it("renames a field and removes one", () => {
    const r = applyMutations(doc, [
      { op: "addField", contentType: "Article", field: { type: "text", name: "body" } },
      { op: "renameField", contentType: "Article", from: "body", to: "content" },
      { op: "removeField", contentType: "Article", field: "title" },
    ]);
    expect(r.errors).toHaveLength(0);
    expect(r.document.contentTypes[0]!.fields.map((f) => f.name)).toEqual(["content"]);
  });
});
