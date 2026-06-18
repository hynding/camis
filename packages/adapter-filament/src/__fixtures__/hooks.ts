import type { IrBundle } from "@camis/permissions";

export const hooksBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "dateTime", name: "publishedAt" },
        ],
      },
    ],
    components: [],
    hooks: [
      {
        name: "TransformTitle",
        trigger: "onPublish",
        contentType: "Article",
        input: [{ name: "title", type: "string" }],
        output: [{ name: "title", type: "string" }],
      },
    ],
  },
  roles: [],
};
