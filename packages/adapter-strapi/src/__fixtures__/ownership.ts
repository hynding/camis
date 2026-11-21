import type { Expression } from "@camis/expr";
import type { IrBundle } from "@camis/permissions";

const owned: Expression = {
  kind: "eq",
  left: { kind: "var", name: "record.ownerId" },
  right: { kind: "var", name: "user.id" },
};
const shared: Expression = {
  kind: "eq",
  left: { kind: "var", name: "record.shared" },
  right: { kind: "lit", value: true },
};

/**
 * Notes owned by the account that made them: members manage their own, guests read the shared
 * ones, reviewers read every note but edit only their own, and the admin role does anything.
 */
export const ownershipBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "User",
        kind: "collection",
        builtin: "user",
        fields: [
          { type: "string", name: "username" },
          { type: "email", name: "email" },
        ],
      },
      {
        name: "Note",
        kind: "collection",
        fields: [
          { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
          { type: "string", name: "title" },
          { type: "boolean", name: "shared" },
        ],
      },
      {
        name: "Tag",
        kind: "collection",
        fields: [
          { type: "string", name: "label" },
          { type: "relation", name: "note", relationKind: "manyToOne", target: "Note" },
        ],
      },
    ],
    components: [],
  },
  roles: [
    {
      name: "public",
      grants: [
        { contentType: "Note", actions: ["read"], condition: shared },
        { contentType: "Tag", actions: ["read"] },
      ],
    },
    {
      name: "member",
      grants: [
        {
          contentType: "Note",
          actions: ["create", "read", "update", "delete"],
          condition: owned,
          assign: { owner: "user.id" },
        },
        { contentType: "Tag", actions: ["read"] },
      ],
    },
    {
      name: "reviewer",
      grants: [
        { contentType: "Note", actions: ["read"] },
        { contentType: "Note", actions: ["update", "delete"], condition: owned },
      ],
    },
    {
      name: "manager",
      admin: true,
      grants: [{ contentType: "Note", actions: ["create", "read", "update", "delete"] }],
    },
  ],
};
