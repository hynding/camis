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
          { type: "json", name: "meta" },
          { type: "media", name: "cover" },
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
        ],
      },
      {
        name: "Author",
        kind: "collection",
        fields: [
          { type: "string", name: "name", required: true },
          { type: "email", name: "email", unique: true },
        ],
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
