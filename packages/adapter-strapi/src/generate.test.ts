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
    const result = strapiAdapter.generate({ document: doc, roles: [] }, { projectName: "blog" });
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("src/api/article/content-types/article/schema.json");
    expect(paths).toContain("src/api/author/content-types/author/schema.json");
    expect(paths).toContain("package.json");
    expect(result.manifest.files.length).toBeGreaterThan(0);
  });

  it("derives names even if the input is not pre-normalized (generate normalizes)", () => {
    const result = strapiAdapter.generate({ document: doc, roles: [] }, { projectName: "blog" });
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
    const result = strapiAdapter.generate(
      { document: withSoftDelete, roles: [] },
      { projectName: "blog" },
    );
    expect(result.gaps.gaps.some((g) => g.feature === "softDelete")).toBe(true);
  });
});

it("emits the AI provider + lifecycle for an AI-bearing content type", () => {
  const r = strapiAdapter.generate(
    {
      document: {
        version: 1,
        contentTypes: [
          {
            name: "Article",
            kind: "collection",
            fields: [
              { type: "text", name: "body" },
              {
                type: "text",
                name: "summary",
                ai: { prompt: "Sum {{body}}", trigger: "onCreate" },
              },
            ],
          },
        ],
        components: [],
      },
      roles: [],
    } as never,
    { projectName: "blog" },
  );
  const paths = r.files.map((f) => f.path);
  expect(paths).toContain("src/ai/provider.ts");
  expect(paths).toContain("src/api/article/content-types/article/lifecycles.ts");
});
it("emits no AI files when no content type has an ai field", () => {
  const r = strapiAdapter.generate(
    {
      document: {
        version: 1,
        contentTypes: [
          { name: "Article", kind: "collection", fields: [{ type: "text", name: "body" }] },
        ],
        components: [],
      },
      roles: [],
    } as never,
    { projectName: "blog" },
  );
  expect(r.files.some((f) => f.path === "src/ai/provider.ts")).toBe(false);
});
it("gaps a content type with BOTH a hook and an ai field (lifecycle collision)", () => {
  const r = strapiAdapter.generate(
    {
      document: {
        version: 1,
        hooks: [
          {
            name: "Enrich",
            trigger: "onPublish",
            contentType: "Article",
            input: [{ name: "body", type: "text" }],
            output: [{ name: "summary", type: "text" }],
          },
        ],
        contentTypes: [
          {
            name: "Article",
            kind: "collection",
            fields: [
              { type: "text", name: "body" },
              {
                type: "text",
                name: "summary",
                ai: { prompt: "Sum {{body}}", trigger: "onCreate" },
              },
            ],
          },
        ],
        components: [],
      },
      roles: [],
    } as never,
    { projectName: "blog" },
  );
  expect(
    r.gaps.gaps.some(
      (g) => g.feature === "aiHookCollision" && g.location.contentType === "Article",
    ),
  ).toBe(true);
  expect(
    r.files.filter((f) => f.path === "src/api/article/content-types/article/lifecycles.ts"),
  ).toHaveLength(1);
});

describe("strapiAdapter.generate — components + inverses", () => {
  const doc = {
    version: 1 as const,
    contentTypes: [
      {
        name: "Article",
        kind: "collection" as const,
        fields: [
          {
            type: "relation" as const,
            name: "author",
            relationKind: "manyToOne" as const,
            target: "Author",
            inverse: "articles",
          },
          { type: "component" as const, name: "seo", component: "SeoMeta", repeatable: false },
          { type: "dynamicZone" as const, name: "blocks", components: ["SeoMeta"] },
        ],
      },
      {
        name: "Author",
        kind: "collection" as const,
        fields: [{ type: "string" as const, name: "name" }],
      },
    ],
    components: [{ name: "SeoMeta", fields: [{ type: "string" as const, name: "metaTitle" }] }],
  };

  it("emits a component json file", () => {
    const r = strapiAdapter.generate({ document: doc, roles: [] }, { projectName: "blog" });
    expect(r.files.map((f) => f.path)).toContain("src/components/shared/seo-meta.json");
  });

  it("adds the synthesized inverse attribute to the target type schema", () => {
    const r = strapiAdapter.generate({ document: doc, roles: [] }, { projectName: "blog" });
    const author = JSON.parse(r.files.find((f) => f.path.endsWith("author/schema.json"))!.content);
    expect(author.attributes.articles).toEqual({
      type: "relation",
      relation: "oneToMany",
      target: "api::article.article",
      mappedBy: "author",
    });
  });

  it("reports dynamicZone as a capability gap and omits it", () => {
    const r = strapiAdapter.generate({ document: doc, roles: [] }, { projectName: "blog" });
    expect(r.gaps.gaps.some((g) => g.feature === "dynamicZone")).toBe(true);
    const article = JSON.parse(
      r.files.find((f) => f.path.endsWith("article/schema.json"))!.content,
    );
    expect(article.attributes.blocks).toBeUndefined();
  });
});
