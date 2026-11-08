import type { IrBundle } from "@camis/permissions";

// A policy on some of a collection type's actions, a middleware on all of a single type's, and a
// type with neither, whose routes stay as they were.
export const routeHooksBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [{ type: "string", name: "title", required: true }],
      },
      {
        name: "Homepage",
        kind: "single",
        fields: [{ type: "string", name: "headline" }],
      },
      {
        name: "Tag",
        kind: "collection",
        fields: [{ type: "string", name: "name" }],
      },
    ],
    components: [],
    policies: [{ name: "IsOwner", contentType: "Article", actions: ["update", "delete"] }],
    middlewares: [
      { name: "AuditTrail", contentType: "Article", actions: ["create", "update", "delete"] },
      { name: "CacheHomepage", contentType: "Homepage" },
    ],
  },
  roles: [{ name: "Editor", admin: true, grants: [{ contentType: "Article", actions: ["read"] }] }],
};
