import type { Expression } from "@camis/expr";
import { CREATED_BY, type IrBundle } from "@camis/permissions";

/** Strapi's admin::is-creator: the entry was created by the signed-in admin account. */
const isCreator: Expression = {
  kind: "eq",
  left: { kind: "var", name: CREATED_BY },
  right: { kind: "var", name: "user.id" },
};

/**
 * Strapi's default Editor and Author admin roles over a draft-and-publish type (Story) and a plain
 * one (Memo): the Editor may do everything, the Author only to entries it created. CI's
 * author-role job overlays it (scripts/overlay.ts --bundle author-role) and runs AuthorRoleTest.
 */
export const authorRoleBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "User",
        kind: "collection",
        builtin: "user",
        fields: [
          { type: "string", name: "username", required: true, unique: true },
          { type: "email", name: "email", required: true, unique: true },
        ],
      },
      {
        name: "Story",
        kind: "collection",
        names: { plural: "Stories" },
        options: { draftPublish: true },
        fields: [{ type: "string", name: "title", required: true }],
      },
      {
        name: "Memo",
        kind: "collection",
        names: { plural: "Memos" },
        fields: [{ type: "string", name: "title", required: true }],
      },
    ],
    components: [],
  },
  roles: [
    {
      name: "editor",
      admin: true,
      grants: [
        { contentType: "Story", actions: ["create", "read", "update", "delete", "publish"] },
        { contentType: "Memo", actions: ["create", "read", "update", "delete"] },
      ],
    },
    {
      name: "author",
      admin: true,
      grants: [
        {
          contentType: "Story",
          actions: ["create", "read", "update", "delete", "publish"],
          condition: isCreator,
        },
        {
          contentType: "Memo",
          actions: ["create", "read", "update", "delete"],
          condition: isCreator,
        },
      ],
    },
    // The content API's users read every story: an admin role's condition is not theirs.
    { name: "authenticated", grants: [{ contentType: "Story", actions: ["read"] }] },
  ],
};
