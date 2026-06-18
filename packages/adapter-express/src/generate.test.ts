import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { expressAdapter } from "./generate";

const bundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "relation", name: "x", relationKind: "manyToOne", target: "Tag" },
        ],
      },
    ],
    components: [],
  },
  roles: [],
};

describe("expressAdapter", () => {
  const result = expressAdapter.generate(bundle, { projectName: "blog" });
  const paths = result.files.map((f) => f.path);
  it("emits the skeleton + schema + routes", () => {
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/db/schema.ts");
    expect(paths).toContain("src/routes/articles.ts");
    expect(paths).toContain("src/server.ts");
  });
  it("builds a manifest and gaps a non-subset field type", () => {
    expect(result.manifest.files.length).toBe(result.files.length);
    expect(result.gaps.gaps.some((g) => g.feature === "relation")).toBe(true);
  });
  it("is idempotent", () => {
    expect(expressAdapter.generate(bundle, { projectName: "blog" })).toEqual(result);
  });
});
