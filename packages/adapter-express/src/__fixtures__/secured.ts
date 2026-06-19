import type { IrBundle } from "@camis/permissions";

export const secured: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "string", name: "status" },
          { type: "string", name: "secretNotes" },
          {
            type: "relation",
            name: "author",
            relationKind: "manyToOne",
            target: "Author",
            inverse: "articles",
          },
        ],
      },
      {
        name: "Author",
        kind: "collection",
        fields: [{ type: "string", name: "name", required: true }],
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
          actions: ["create", "read", "update", "delete", "publish"],
          fieldRules: [{ field: "secretNotes", access: "write" }],
        },
        { contentType: "Author", actions: ["create", "read", "update", "delete"] },
      ],
    },
    {
      name: "Viewer",
      grants: [
        {
          contentType: "Article",
          actions: ["read"],
          condition: {
            kind: "eq",
            left: { kind: "var", name: "record.status" },
            right: { kind: "lit", value: "published" },
          },
          fieldRules: [
            {
              field: "secretNotes",
              access: "read",
              when: {
                kind: "eq",
                left: { kind: "var", name: "user.id" },
                right: { kind: "var", name: "record.title" },
              },
            },
          ],
        },
        { contentType: "Author", actions: ["read"] },
      ],
    },
    {
      name: "public",
      grants: [
        {
          contentType: "Article",
          actions: ["read"],
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
