import type { IrBundle } from "@camis/permissions";

export const blog: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "text", name: "body" },
          { type: "boolean", name: "published" },
          { type: "dateTime", name: "publishedAt" },
        ],
      },
    ],
    components: [],
  },
  roles: [],
};
