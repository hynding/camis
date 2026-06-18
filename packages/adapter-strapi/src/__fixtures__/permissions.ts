import type { IrBundle } from "@camis/permissions";

export const permissionsBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        options: { draftPublish: true },
        fields: [
          { type: "string", name: "title" },
          { type: "string", name: "secret" },
        ],
      },
    ],
    components: [],
  },
  roles: [
    {
      name: "Editor",
      description: "Edits articles",
      grants: [
        {
          contentType: "Article",
          actions: ["read", "update", "publish"],
          fieldRules: [
            {
              field: "secret",
              access: "read",
              when: {
                kind: "eq",
                left: { kind: "var", name: "user.role" },
                right: { kind: "lit", value: "editor" },
              },
            },
          ],
          condition: {
            kind: "eq",
            left: { kind: "var", name: "user.role" },
            right: { kind: "lit", value: "editor" },
          },
        },
      ],
    },
  ],
};
