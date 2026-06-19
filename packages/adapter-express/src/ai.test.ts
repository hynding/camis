import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { aiColumnsOf, aiFiles, hasAiField } from "./ai";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "text", name: "body" },
        { type: "text", name: "summary", ai: { prompt: "Sum {{body}}", trigger: "onCreate" } },
      ],
    },
  ],
  components: [],
} as IrDocument;

describe("ai emitter", () => {
  it("hasAiField detects an ai annotation", () => {
    expect(hasAiField(doc)).toBe(true);
    expect(
      hasAiField({
        ...doc,
        contentTypes: [{ name: "X", kind: "collection", fields: [{ type: "text", name: "a" }] }],
      } as IrDocument),
    ).toBe(false);
  });
  it("aiColumnsOf returns the snake columns of ai fields", () => {
    expect(aiColumnsOf(doc.contentTypes[0]!)).toEqual(["summary"]);
  });
  it("emits a protected provider seed + an overwrite populate module with the CONFIG", () => {
    const files = aiFiles(doc);
    const provider = files.find((f) => f.path === "src/ai/provider.ts")!;
    expect(provider.mode).toBe("seed");
    expect(provider.content).toContain("export async function generate");
    expect(provider.content).toContain("ANTHROPIC_API_KEY");
    const populate = files.find((f) => f.path === "src/ai/populate.ts")!;
    expect(populate.content).toContain("export async function populateAiFields");
    expect(populate.content).toContain('"Article"');
    expect(populate.content).toContain('"column": "summary"');
    expect(populate.content).toContain('"ph": "body"');
  });
});
