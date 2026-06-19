import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from "./prompts";

const doc: IrDocument = {
  version: 1,
  contentTypes: [{ name: "Article", kind: "collection", fields: [] }],
  components: [],
} as IrDocument;

describe("prompts", () => {
  it("system prompt names the five ops and asks for ops only", () => {
    const s = buildSystemPrompt();
    expect(s).toContain("addContentType");
    expect(s).toContain("renameField");
    expect(s).toContain("JSON array");
  });
  it("user prompt embeds the document (stable JSON) and the instruction", () => {
    const u = buildUserPrompt(doc, "add a published boolean to Article");
    expect(u).toContain('"name": "Article"');
    expect(u).toContain("add a published boolean to Article");
  });
  it("repair prompt includes the rejected ops and the located errors", () => {
    const r = buildRepairPrompt(
      doc,
      "x",
      [{ op: "removeContentType", name: "Ghost" }],
      [
        {
          code: "inapplicable_mutation",
          message: 'content type "Ghost" does not exist',
          location: { contentType: "Ghost" },
          path: [],
        },
      ],
    );
    expect(r).toContain("removeContentType");
    expect(r).toContain("inapplicable_mutation");
    expect(r).toContain('content type "Ghost" does not exist');
  });
});
