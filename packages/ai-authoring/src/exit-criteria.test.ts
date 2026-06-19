import { describe, expect, it } from "vitest";
import { validate } from "@camis/ir-core";
import type { IrDocument } from "@camis/ir-schema";
import { author, type AiClient } from "./index";

const article: IrDocument = {
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

const once = (proposal: unknown): AiClient => ({ propose: () => Promise.resolve(proposal) });

describe("9B exit criteria", () => {
  it("an NL instruction yields a mutation that round-trips through validate", async () => {
    const r = await author({
      instruction: "add a published boolean to Article",
      document: article,
      client: once([
        { op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } },
      ]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(validate(r.document).ok).toBe(true); // round-trips through the guardrail
      expect(r.document.contentTypes[0]!.fields.map((f) => f.name)).toEqual(["title", "published"]);
    }
  });
  it("an invalid proposal is rejected, never returned as ok", async () => {
    const r = await author({
      instruction: "break it",
      document: article,
      maxRepairs: 0,
      client: once([
        { op: "addField", contentType: "Article", field: { type: "string", name: "title" } }, // duplicate field → invalid
      ]),
    });
    expect(r.ok).toBe(false);
  });
});
