import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { strapiAdapter } from "./generate";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "string", name: "title" },
        {
          type: "relation",
          name: "author",
          relationKind: "manyToOne",
          target: "Author",
          inverse: "articles",
        },
      ],
      options: { draftPublish: true },
    },
    { name: "Author", kind: "collection", fields: [{ type: "string", name: "name" }] },
  ],
  components: [],
};

describe("strapiAdapter.generate", () => {
  it("emits a schema.json + api files for every content type, plus the skeleton", () => {
    const result = strapiAdapter.generate(doc, { projectName: "blog" });
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("src/api/article/content-types/article/schema.json");
    expect(paths).toContain("src/api/author/content-types/author/schema.json");
    expect(paths).toContain("package.json");
    expect(result.manifest.files.length).toBeGreaterThan(0);
  });

  it("derives names even if the input is not pre-normalized (generate normalizes)", () => {
    const result = strapiAdapter.generate(doc, { projectName: "blog" });
    const schemaFile = result.files.find((f) => f.path.endsWith("article/schema.json"))!;
    expect(JSON.parse(schemaFile.content).info.pluralName).toBe("articles");
  });

  it("reports softDelete as a capability gap", () => {
    const withSoftDelete: IrDocument = {
      ...doc,
      contentTypes: [
        { ...doc.contentTypes[0]!, options: { softDelete: true } },
        doc.contentTypes[1]!,
      ],
    };
    const result = strapiAdapter.generate(withSoftDelete, { projectName: "blog" });
    expect(result.gaps.gaps.some((g) => g.feature === "softDelete")).toBe(true);
  });
});
