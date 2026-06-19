import type { IrBundle } from "@camis/permissions";

export const aiFixture: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "text", name: "body" },
          {
            type: "text",
            name: "summary",
            ai: { prompt: "Summarize in one line: {{body}}", trigger: "onCreateOrUpdate" },
          },
        ],
      },
    ],
    components: [],
  },
  roles: [],
};
