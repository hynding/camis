import type { IrDocument } from "@camis/ir-schema";
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../../generate";

// A project imported from strapi-php keeps its snake_case attribute names on the wire: the IR
// field is camelCase and names the key the API already sends.
describe("API names", () => {
  const document: IrDocument = {
    version: 1,
    contentTypes: [
      {
        name: "Page",
        kind: "collection",
        fields: [
          { type: "string", name: "heroTitle", names: { api: "hero_title" } },
          {
            type: "component",
            name: "seoMeta",
            names: { api: "seo_meta" },
            component: "Seo",
            repeatable: false,
          },
          {
            type: "relation",
            name: "mainAuthor",
            names: { api: "main_author" },
            relationKind: "manyToOne",
            target: "Author",
            inverse: "writtenPages",
            inverseNames: { api: "written_pages" },
          },
        ],
      },
      { name: "Author", kind: "collection", fields: [{ type: "string", name: "name" }] },
    ],
    components: [
      {
        name: "Seo",
        fields: [{ type: "string", name: "metaTitle", names: { api: "meta_title" } }],
      },
    ],
  };
  const result = filamentAdapter.generate(
    { document, roles: [] },
    { projectName: "oyl", apiStyle: "strapi", documentation: true, graphql: true },
  );
  const file = (suffix: string) => result.files.find((f) => f.path.endsWith(suffix))!.content;
  const serializer = result.files.find((f) => f.path.endsWith("PageSerializer.php"))!.content;

  it("sends and reads each field under its API name, over the same columns", () => {
    expect(serializer).toContain("'hero_title' => $m->hero_title,");
    expect(serializer).toContain("'seo_meta' => self::nested([");
    expect(serializer).toContain("'meta_title' => $m->seo_meta_meta_title,");
    expect(serializer).toContain("'hero_title' => self::dig($data, ['hero_title']),");
    expect(serializer).toContain("'seo_meta.meta_title' => ['column' => 'seo_meta_meta_title'");
    expect(serializer).toContain("'main_author' => ['relation' => 'mainAuthor'");
    expect(serializer).toContain("public const COMPONENTS = ['seo_meta'];");
  });

  // getstarted's category lists its relation-locales as `relation_locales`, the key the declaring
  // side's inversedBy names, while the IR's inverse is camelCase like every other field name.
  it("sends a relation's inverse under the key the declaring side names for it", () => {
    expect(file("AuthorSerializer.php")).toContain(
      "'written_pages' => ['relation' => 'writtenPages', 'kind' => 'hasMany'",
    );
    expect(file("Models/Author.php")).toContain("public function writtenPages(): HasMany");
  });

  it("documents, schemas and transfers the inverse under that key", () => {
    const openapi = JSON.parse(file("openapi.json")) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const author = openapi.components.schemas.ApiAuthorAuthorDocument?.properties;
    expect(author).toHaveProperty("written_pages");
    expect(author).not.toHaveProperty("writtenPages");
    expect(file("schema.graphql")).toMatch(/written_pages[(:]/);
    expect(file("schema.graphql")).not.toContain("writtenPages");
    const schemas = file("resources/strapi/schemas.jsonl");
    expect(schemas).toContain(
      '"main_author":{"type":"relation","relation":"manyToOne","target":"api::author.author","inversedBy":"written_pages"}',
    );
    expect(schemas).toContain(
      '"written_pages":{"type":"relation","relation":"oneToMany","target":"api::page.page","mappedBy":"main_author"}',
    );
    expect(file("StrapiTransferMap.php")).toContain("'inverse' => 'written_pages',");
    expect(file("StrapiTransferMap.php")).not.toContain("'inverse' => 'writtenPages',");
  });
});
