import { describe, expect, it } from "vitest";
import type { ContentType, IrDocument } from "@camis/ir-schema";
import { aiFieldContentTypes, aiLifecycleFile, aiProviderFile, hasAiField } from "./ai";

const ct: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "text", name: "body" },
    { type: "text", name: "summary", ai: { prompt: "Sum {{body}}", trigger: "onCreateOrUpdate" } },
  ],
} as ContentType;
const doc: IrDocument = { version: 1, contentTypes: [ct], components: [] } as IrDocument;

describe("strapi ai emitter", () => {
  it("detects AI content types", () => {
    expect(hasAiField(doc)).toBe(true);
    expect(aiFieldContentTypes(doc).map((c) => c.name)).toEqual(["Article"]);
  });
  it("emits a protected provider seed", () => {
    const f = aiProviderFile();
    expect(f.path).toBe("src/ai/provider.ts");
    expect(f.mode).toBe("seed");
    expect(f.content).toContain("export async function generate");
    expect(f.content).toContain("ANTHROPIC_API_KEY");
  });
  it("emits a lifecycle that populates from event.params.data using field-name keys", () => {
    const f = aiLifecycleFile(ct);
    expect(f.path).toBe("src/api/article/content-types/article/lifecycles.ts");
    expect(f.content).toContain('import { generate } from "../../../../ai/provider";');
    expect(f.content).toContain("async beforeCreate(");
    expect(f.content).toContain("async beforeUpdate(");
    expect(f.content).toContain('"column": "summary"');
    expect(f.content).toContain('"sources": [');
    expect(f.content).toContain('"body"');
  });
});
