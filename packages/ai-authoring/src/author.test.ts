import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { author } from "./author";
import type { AiClient } from "./client";

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

const scripted = (...proposals: unknown[]): AiClient => {
  let i = 0;
  return { propose: () => Promise.resolve(proposals[Math.min(i++, proposals.length - 1)]) };
};

describe("author", () => {
  it("returns ok with the applied document on a valid first proposal", async () => {
    const r = await author({
      instruction: "add published",
      document: doc,
      client: scripted([
        { op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } },
      ]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.contentTypes[0]!.fields.map((f) => f.name)).toContain("published");
      expect(r.ops).toHaveLength(1);
    }
  });
  it("repairs an inapplicable op then succeeds", async () => {
    const r = await author({
      instruction: "add published",
      document: doc,
      client: scripted(
        [{ op: "addField", contentType: "Ghost", field: { type: "boolean", name: "published" } }],
        [{ op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } }],
      ),
    });
    expect(r.ok).toBe(true);
  });
  it("rejects (ok:false) when the budget is exhausted, never returning an invalid doc", async () => {
    const r = await author({
      instruction: "x",
      document: doc,
      maxRepairs: 1,
      client: scripted([
        { op: "addField", contentType: "Ghost", field: { type: "boolean", name: "x" } },
      ]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "inapplicable_mutation")).toBe(true);
  });
  it("feeds a schema-invalid proposal back as a repair", async () => {
    const r = await author({
      instruction: "x",
      document: doc,
      client: scripted(
        [{ op: "frobnicate" }],
        [{ op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } }],
      ),
    });
    expect(r.ok).toBe(true);
  });
});
