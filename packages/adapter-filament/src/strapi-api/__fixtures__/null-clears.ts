import type { IrBundle } from "@camis/permissions";

/**
 * An explicit null in an update body, as Strapi takes it (issue #122): an optional field of every
 * kind is cleared, a required one refused (a required component too, but on a draft), a link
 * unlinked and a component cleared, its repeatables' items with it, while a key the body leaves
 * out keeps its value and a field the grant assigns stays the caller's. BrandKit's
 * `code` is unique, patterned and measured, which a null must not run; `tone` has a default, which
 * a null on create does not take (Strapi's database layer takes it for a missing key only).
 * CI's null-clears job overlays it (scripts/overlay.ts --bundle null-clears) and runs
 * NullClearsTest on SQLite, MySQL and PostgreSQL.
 */
export const nullClearsBundle: IrBundle = {
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
      { name: "File", kind: "collection", builtin: "file", fields: [] },
      {
        name: "Partner",
        kind: "collection",
        names: { plural: "Partners" },
        fields: [{ type: "string", name: "title", required: true }],
      },
      {
        name: "BrandKit",
        kind: "collection",
        names: { plural: "BrandKits" },
        fields: [
          { type: "string", name: "title", required: true },
          { type: "string", name: "tagline" },
          { type: "text", name: "notes" },
          { type: "string", name: "tone", default: "plain" },
          {
            type: "string",
            name: "code",
            unique: true,
            minLength: 3,
            pattern: "^[A-Z]+$",
          },
          { type: "integer", name: "rank", min: 1, max: 9 },
          { type: "decimal", name: "share", precision: 12, scale: 3 },
          { type: "boolean", name: "active" },
          { type: "date", name: "launchedOn" },
          { type: "timestamp", name: "seenAt" },
          { type: "media", name: "logo", allowedTypes: ["image"] },
          { type: "media", name: "gallery", multiple: true },
          { type: "relation", name: "partner", relationKind: "manyToOne", target: "Partner" },
          { type: "relation", name: "allies", relationKind: "manyToMany", target: "Partner" },
          { type: "component", name: "seo", component: "Seo", repeatable: false },
          {
            type: "component",
            name: "identity",
            component: "Identity",
            repeatable: false,
            required: true,
          },
          { type: "component", name: "links", component: "Link", repeatable: true },
          { type: "dynamicZone", name: "blocks", components: ["Link"] },
        ],
      },
      // A draft takes a null for a required component, which a published write refuses.
      {
        name: "Campaign",
        kind: "collection",
        names: { plural: "Campaigns" },
        options: { draftPublish: true },
        fields: [
          { type: "string", name: "title" },
          {
            type: "component",
            name: "identity",
            component: "Identity",
            repeatable: false,
            required: true,
          },
        ],
      },
      // An account's own profile, whose owner the grant assigns (AuthorRoleTest's shape).
      {
        name: "Profile",
        kind: "collection",
        names: { plural: "Profiles" },
        fields: [
          { type: "string", name: "displayName", required: true },
          { type: "text", name: "bio" },
          {
            type: "relation",
            name: "owner",
            relationKind: "manyToOne",
            target: "User",
            required: true,
          },
        ],
      },
    ],
    components: [
      {
        name: "Seo",
        fields: [
          { type: "string", name: "headline" },
          { type: "string", name: "summary" },
          // Nested in a component, so a null for the component reaches its items through it.
          { type: "component", name: "keywords", component: "Link", repeatable: true },
        ],
      },
      { name: "Link", fields: [{ type: "string", name: "label" }] },
      { name: "Identity", fields: [{ type: "string", name: "mark" }] },
    ],
  },
  roles: [
    {
      name: "authenticated",
      grants: [
        { contentType: "Partner", actions: ["read"] },
        { contentType: "File", actions: ["read"] },
        { contentType: "BrandKit", actions: ["create", "read", "update", "delete"] },
        { contentType: "Campaign", actions: ["create", "read", "update", "publish"] },
        {
          contentType: "Profile",
          actions: ["create", "read", "update"],
          condition: {
            kind: "eq",
            left: { kind: "var", name: "record.ownerId" },
            right: { kind: "var", name: "user.id" },
          },
          assign: { owner: "user.id" },
        },
      ],
    },
  ],
};
