import type { Expression } from "@camis/expr";
import { CREATED_BY, CREATOR_SHARES_ROLE, type IrBundle } from "@camis/permissions";

/** Strapi's admin::is-creator: the entry was created by the signed-in admin account. */
const isCreator: Expression = {
  kind: "eq",
  left: { kind: "var", name: CREATED_BY },
  right: { kind: "var", name: "user.id" },
};

/** Strapi's admin::has-same-role-as-creator: the entry's creator holds one of the account's roles. */
const sharesRole: Expression = {
  kind: "eq",
  left: { kind: "var", name: CREATOR_SHARES_ROLE },
  right: { kind: "lit", value: true },
};

/**
 * Strapi's default Editor and Author admin roles over a draft-and-publish type (Story) and a plain
 * one (Memo): the Editor may do everything, the Author only to entries it created, a Reviewer reads
 * and changes the memos an account of its role created. Memo's list and read are open to anyone,
 * as Strapi's route auth: false opens them. CI's author-role job overlays it (scripts/overlay.ts
 * --bundle author-role) and runs AuthorRoleTest, PublicActionsTest and EndpointsTest.
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
      // The media library, whose files an Author reads and changes only where it uploaded them.
      { name: "File", kind: "collection", builtin: "file", fields: [] },
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
        // Its router's find and findOne set auth: false (PublicActionsTest).
        options: { publicApiActions: ["list", "read"] },
        fields: [{ type: "string", name: "title", required: true }],
      },
    ],
    components: [],
    // Strapi custom routes beside Memo: one its users may call, one anyone may (EndpointsTest).
    endpoints: [
      { name: "MemoPin", contentType: "Memo", method: "POST", path: "/memos/:id/pin" },
      { name: "MemoCount", contentType: "Memo", method: "GET", path: "/memos/count", public: true },
    ],
  },
  roles: [
    {
      name: "editor",
      admin: true,
      grants: [
        { contentType: "Story", actions: ["create", "read", "update", "delete", "publish"] },
        { contentType: "Memo", actions: ["create", "read", "update", "delete"] },
        { contentType: "File", actions: ["create", "read", "update", "delete"] },
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
        { contentType: "File", actions: ["create"] },
        { contentType: "File", actions: ["read", "update", "delete"], condition: isCreator },
      ],
    },
    // A role whose accounts share their memos (admin::has-same-role-as-creator).
    {
      name: "reviewer",
      admin: true,
      grants: [
        { contentType: "Memo", actions: ["create"] },
        { contentType: "Memo", actions: ["read", "update"], condition: sharesRole },
      ],
    },
    // The content API's users read every story: an admin role's condition is not theirs.
    {
      name: "authenticated",
      grants: [{ contentType: "Story", actions: ["read"] }],
      endpoints: ["MemoPin"],
    },
  ],
};
