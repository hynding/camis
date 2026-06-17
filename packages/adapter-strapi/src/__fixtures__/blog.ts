import type { IrDocument } from "@camis/ir-schema";

export const blog: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "string", name: "title", required: true },
        { type: "uid", name: "slug", targetField: "title" },
        { type: "richText", name: "body" },
        { type: "enumeration", name: "status", values: ["draft", "published"], default: "draft" },
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
    {
      name: "Author",
      kind: "collection",
      fields: [{ type: "string", name: "name", required: true }],
    },
  ],
  components: [],
};
