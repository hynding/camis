import type { IrBundle } from "@camis/permissions";

export const catalog: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "richText", name: "body" },
          { type: "enumeration", name: "status", values: ["draft", "published"] },
          { type: "decimal", name: "price" },
          { type: "json", name: "meta" },
          { type: "dateTime", name: "publishedAt" },
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
    components: [{ name: "Seo", fields: [{ type: "string", name: "metaTitle" }] }],
  },
  roles: [],
};
