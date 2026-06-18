import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "./generate";

const bundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [{ type: "string", name: "title", required: true }],
      },
      {
        name: "Tag",
        kind: "collection",
        fields: [{ type: "string", name: "label", required: true }],
      },
    ],
    components: [],
  },
  roles: [],
};

describe("filamentAdapter", () => {
  const result = filamentAdapter.generate(bundle, { projectName: "blog" });
  const paths = result.files.map((f) => f.path);

  it("emits a model, an ordinal migration, and a resource set per content type", () => {
    expect(paths).toContain("app/Models/Article.php");
    expect(paths).toContain("database/migrations/0000_00_00_000001_create_articles_table.php");
    expect(paths).toContain("database/migrations/0000_00_00_000002_create_tags_table.php");
    expect(paths).toContain("app/Filament/Resources/Articles/ArticleResource.php");
  });
  it("builds a manifest and an empty gap report (scalars only)", () => {
    expect(result.manifest.files.length).toBe(result.files.length);
    expect(result.gaps).toEqual({ target: "filament", gaps: [] });
  });
  it("is deterministic / idempotent", () => {
    expect(filamentAdapter.generate(bundle, { projectName: "blog" })).toEqual(result);
  });
});
