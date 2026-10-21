import type { IrDocument } from "@camis/ir-schema";
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";

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
    { projectName: "oyl", apiStyle: "strapi" },
  );
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
});
