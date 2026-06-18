import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "./generate";
import { permissionsBundle } from "./__fixtures__/permissions";

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

const relBundle: IrBundle = {
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
          {
            type: "relation",
            name: "tags",
            relationKind: "manyToMany",
            target: "Tag",
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

describe("filamentAdapter relations + gaps", () => {
  const result = filamentAdapter.generate(relBundle, { projectName: "blog" });
  const paths = result.files.map((f) => f.path);
  it("emits a pivot migration after the content-type migrations", () => {
    expect(paths).toContain("database/migrations/0000_00_00_000004_create_article_tag_table.php");
  });
  it("injects the author_id FK into the articles migration", () => {
    const mig = result.files.find((f) => f.path.endsWith("create_articles_table.php"))!.content;
    expect(mig).toContain("$table->foreignId('author_id')->nullable()->constrained('authors');");
  });
  it("reports the component field as a capability gap", () => {
    expect(
      result.gaps.gaps.some((g) => g.feature === "component" && g.location.field === "seo"),
    ).toBe(true);
  });
});

describe("filamentAdapter permissions", () => {
  const result = filamentAdapter.generate(permissionsBundle, { projectName: "blog" });
  const paths = result.files.map((f) => f.path);
  it("emits the seeder, policy, and Ring1 support file", () => {
    expect(paths).toContain("database/seeders/RolePermissionSeeder.php");
    expect(paths).toContain("app/Policies/ArticlePolicy.php");
    expect(paths).toContain("app/Support/Ring1.php");
  });
  it("has no gaps for the user.*/record.* fixture", () => {
    expect(result.gaps.gaps).toEqual([]);
  });
});
