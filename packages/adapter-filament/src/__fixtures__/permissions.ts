import type { IrBundle } from "@camis/permissions";

export const permissionsBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "string", name: "status" },
        ],
      },
    ],
    components: [],
  },
  roles: [
    {
      name: "Editor",
      grants: [
        {
          contentType: "Article",
          actions: ["read", "update"],
          condition: {
            kind: "eq",
            left: { kind: "var", name: "record.status" },
            right: { kind: "lit", value: "published" },
          },
        },
      ],
    },
  ],
};
