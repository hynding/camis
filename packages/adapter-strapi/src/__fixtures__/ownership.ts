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

const unshared: Expression = {
  kind: "ne",
  left: { kind: "var", name: "record.shared" },
  right: { kind: "lit", value: true },
};

/**
 * Notes owned by the account that made them: members manage their own, guests read the shared
 * ones, reviewers read every note but edit only their own, contributors may only add private
 * notes (a note is shared unless it says otherwise) and read tags, and the admin role does
 * anything. Tags reach
 * notes directly, through a parent tag, and through a repeatable reference component. A note
 * belongs to a category (whose `notes` inverse a reviewer may write), pins tags (each tag pinned on
 * one note at most: `Tag.pinnedOn`, whose inverse is `Note.pinned`), and has an attachment.
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
          { type: "boolean", name: "shared", default: true },
          { type: "media", name: "attachment" },
          {
            type: "relation",
            name: "category",
            relationKind: "manyToOne",
            target: "Category",
            inverse: "notes",
          },
        ],
      },
      { name: "Category", kind: "collection", fields: [{ type: "string", name: "label" }] },
      {
        name: "Tag",
        kind: "collection",
        fields: [
          { type: "string", name: "label" },
          { type: "relation", name: "note", relationKind: "manyToOne", target: "Note" },
          { type: "relation", name: "parent", relationKind: "manyToOne", target: "Tag" },
          { type: "component", name: "refs", component: "Reference", repeatable: true },
          // Owned here: Strapi refuses a bidirectional oneToMany as the owning side.
          {
            type: "relation",
            name: "pinnedOn",
            relationKind: "manyToOne",
            target: "Note",
            inverse: "pinned",
          },
        ],
      },
    ],
    components: [
      {
        name: "Reference",
        fields: [{ type: "relation", name: "note", relationKind: "manyToOne", target: "Note" }],
      },
    ],
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
        { contentType: "Tag", actions: ["create", "read"] },
      ],
    },
    {
      name: "contributor",
      grants: [
        {
          contentType: "Note",
          actions: ["create"],
          condition: unshared,
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
        { contentType: "Category", actions: ["read", "update"] },
      ],
    },
    {
      name: "manager",
      admin: true,
      grants: [{ contentType: "Note", actions: ["create", "read", "update", "delete"] }],
    },
  ],
};
