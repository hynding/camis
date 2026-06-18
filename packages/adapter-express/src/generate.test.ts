import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { expressAdapter, expressAdapterFor } from "./generate";

const bundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "component", name: "seo", component: "Seo", repeatable: false } as never,
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
    expect(result.gaps.gaps.some((g) => g.feature === "component")).toBe(true);
  });
  it("is idempotent", () => {
    expect(expressAdapter.generate(bundle, { projectName: "blog" })).toEqual(result);
  });
});

describe("expressAdapterFor", () => {
  const relBundle = {
    document: {
      version: 1,
      contentTypes: [
        {
          name: "Article",
          kind: "collection",
          fields: [
            { type: "string", name: "title", required: true },
            {
              type: "relation",
              name: "author",
              relationKind: "manyToOne",
              target: "Author",
              inverse: "articles",
            },
            { type: "component", name: "seo", component: "Seo", repeatable: false },
          ],
        },
        {
          name: "Author",
          kind: "collection",
          fields: [{ type: "string", name: "name", required: true }],
        },
      ],
      components: [],
    },
    roles: [],
  } as never;

  it("default export targets sqlite", () => {
    expect(expressAdapter.target).toBe("express");
  });
  it("pg adapter emits a pg schema + camis.schema.json + relation FK + component gap", () => {
    const result = expressAdapterFor("pgsql").generate(relBundle, { projectName: "blog" });
    const schema = result.files.find((f) => f.path === "src/db/schema.ts")!.content;
    expect(schema).toContain("pgTable(");
    expect(schema).toContain("author_id: integer('author_id').references(() => authors.id)");
    expect(result.files.some((f) => f.path === "camis.schema.json")).toBe(true);
    expect(result.gaps.gaps.some((g) => g.feature === "component")).toBe(true);
  });
});
