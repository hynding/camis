import type { IrDocument } from "@camis/ir-schema";

export const hooksDoc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      options: { draftPublish: true },
      fields: [{ type: "string", name: "title", required: true }],
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
};
