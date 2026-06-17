import type { IrDocument } from "@camis/ir-schema";

// Exit-criteria fixture: multiple types, a relation (incl. self-relation), and a component.
export const validBlog: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "string", name: "title", required: true },
        { type: "uid", name: "slug", targetField: "title" },
        {
          type: "relation",
          name: "author",
          relationKind: "manyToOne",
          target: "User",
          inverse: "articles",
        },
        { type: "component", name: "seo", component: "SeoMeta", repeatable: false },
      ],
    },
    { name: "User", kind: "collection", fields: [{ type: "string", name: "email" }] },
    {
      name: "Category",
      kind: "collection",
      fields: [{ type: "relation", name: "parent", relationKind: "manyToOne", target: "Category" }],
    },
  ],
  components: [{ name: "SeoMeta", fields: [{ type: "string", name: "metaTitle" }] }],
};
