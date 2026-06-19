import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { adminResourceFiles } from "./admin-resources";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "string", name: "title", required: true },
        { type: "boolean", name: "published" },
        { type: "enumeration", name: "status", values: ["draft", "published"] },
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
};

describe("adminResourceFiles", () => {
  const files = adminResourceFiles(doc);
  const c = (p: string) => files.find((f) => f.path === p)!.content;
  it("emits App.tsx wiring one Resource per content type", () => {
    const app = c("admin/src/App.tsx");
    expect(app).toContain('<Resource name="articles"');
    expect(app).toContain('<Resource name="authors"');
    expect(app).toContain("dataProvider={dataProvider}");
  });
  it("maps IR fields to react-admin inputs/fields and omits components", () => {
    const articles = c("admin/src/resources/articles.tsx");
    expect(articles).toContain('<TextInput source="title" />');
    expect(articles).toContain('<BooleanInput source="published" />');
    expect(articles).toContain(
      '<SelectInput source="status" choices={[{ id: "draft", name: "draft" }, { id: "published", name: "published" }]} />',
    );
    expect(articles).toContain('<ReferenceInput source="author_id" reference="authors" />');
    expect(articles).not.toContain("seo");
  });
});
