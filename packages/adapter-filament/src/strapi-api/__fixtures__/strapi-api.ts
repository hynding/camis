import type { Expression } from "@camis/expr";
import type { IrBundle } from "@camis/permissions";

const ownerEq = {
  kind: "eq",
  left: { kind: "var", name: "record.ownerId" },
  right: { kind: "var", name: "user.id" },
} as const;
const creatorEq = {
  kind: "eq",
  left: { kind: "var", name: "record.creatorId" },
  right: { kind: "var", name: "user.id" },
} as const;
// A catalog type: everyone reads public rows, but only the creator may write them. Read and write
// therefore need separate grants — one grant covering both would make public rows world-writable.
const publicOrMine: Expression = {
  kind: "or",
  args: [
    {
      kind: "eq",
      left: { kind: "var", name: "record.visibility" },
      right: { kind: "lit", value: "public" },
    },
    {
      kind: "eq",
      left: { kind: "var", name: "record.creatorId" },
      right: { kind: "var", name: "user.id" },
    },
  ],
};

export const strapiApiBundle: IrBundle = {
  defaultRole: "authenticated",
  document: {
    version: 1,
    contentTypes: [
      {
        name: "User",
        kind: "collection",
        builtin: "user",
        fields: [
          { type: "string", name: "username", required: true, unique: true },
          { type: "email", name: "email", required: true },
        ],
      },
      // The media library's files (media-vectors.json): Book and Post link them through media fields.
      { name: "File", kind: "collection", builtin: "file", fields: [] },
      {
        name: "Note",
        kind: "collection",
        names: { plural: "Notes" },
        options: { upsertBy: "recordId" },
        fields: [
          { type: "string", name: "recordId", required: true, unique: true },
          { type: "text", name: "text", required: true },
          { type: "json", name: "tags" },
          { type: "dateTime", name: "occurredAt", required: true },
          { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
        ],
      },
      {
        name: "Transaction",
        kind: "collection",
        names: { plural: "Transactions" },
        options: { upsertBy: "recordId" },
        fields: [
          { type: "string", name: "recordId", required: true, unique: true },
          { type: "component", name: "amount", component: "Money", repeatable: false },
          { type: "decimal", name: "fee" },
          { type: "date", name: "occurredOn" },
          { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
        ],
      },
      {
        name: "ActivitySession",
        kind: "collection",
        names: { plural: "ActivitySessions" },
        options: { upsertBy: "recordId" },
        fields: [
          { type: "string", name: "recordId", required: true, unique: true },
          { type: "component", name: "quantities", component: "Quantity", repeatable: true },
          { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
        ],
      },
      {
        name: "Activity",
        kind: "collection",
        names: { plural: "Activities" },
        options: { upsertBy: "recordId" },
        fields: [
          { type: "string", name: "recordId", required: true, unique: true },
          { type: "string", name: "name", required: true },
          {
            type: "enumeration",
            name: "visibility",
            values: ["private", "public"],
            default: "public",
          },
          { type: "relation", name: "creator", relationKind: "manyToOne", target: "User" },
        ],
      },
      { name: "Tag", kind: "collection", fields: [{ type: "string", name: "label" }] },
      // Draft & Publish (draft-publish-vectors.json): Topic is a target with both versions, Post a
      // source with both, linking a plain type (Author) and a draft-and-publish one (Topic).
      {
        name: "Topic",
        kind: "collection",
        names: { plural: "Topics" },
        options: { draftPublish: true },
        fields: [{ type: "string", name: "name", required: true }],
      },
      {
        name: "Post",
        kind: "collection",
        names: { plural: "Posts" },
        options: { draftPublish: true },
        fields: [
          { type: "string", name: "title", required: true },
          { type: "integer", name: "views" },
          { type: "relation", name: "author", relationKind: "manyToOne", target: "Author" },
          { type: "relation", name: "topics", relationKind: "manyToMany", target: "Topic" },
          { type: "media", name: "image", allowedTypes: ["image"] },
        ],
      },
      // Internationalization (i18n-vectors.json): Category and Article are localized, Article.code
      // is shared by every locale, and Page is localized with draft and publish too.
      {
        name: "Category",
        kind: "collection",
        names: { plural: "Categories" },
        options: { localized: true },
        fields: [{ type: "string", name: "name" }],
      },
      {
        name: "Article",
        kind: "collection",
        names: { plural: "Articles" },
        options: { localized: true },
        fields: [
          { type: "string", name: "title" },
          { type: "string", name: "code", localized: false },
          { type: "relation", name: "category", relationKind: "manyToOne", target: "Category" },
          { type: "relation", name: "genres", relationKind: "manyToMany", target: "Genre" },
        ],
      },
      {
        name: "Page",
        kind: "collection",
        names: { plural: "Pages" },
        options: { localized: true, draftPublish: true },
        fields: [
          { type: "string", name: "title" },
          { type: "component", name: "panel", component: "Panel", repeatable: false },
        ],
      },
      // Dynamic zones (dynamic-zone-vectors.json): Landing's blocks hold Hero and Quantity items,
      // with draft and publish so publishing copies them.
      {
        name: "Landing",
        kind: "collection",
        names: { plural: "Landings" },
        options: { draftPublish: true },
        fields: [
          { type: "string", name: "title", required: true },
          { type: "dynamicZone", name: "blocks", components: ["Hero", "Quantity"] },
        ],
      },
      // Single types (single-type-vectors.json): Homepage has draft and publish, a relation and a
      // component; Global is localized, its contact shared by every locale.
      {
        name: "Homepage",
        kind: "single",
        names: { plural: "Homepages" },
        options: { draftPublish: true },
        fields: [
          { type: "string", name: "title", required: true },
          { type: "text", name: "body" },
          { type: "relation", name: "featured", relationKind: "manyToOne", target: "Book" },
          { type: "component", name: "price", component: "Money", repeatable: false },
        ],
      },
      {
        name: "Global",
        kind: "single",
        names: { plural: "Globals" },
        options: { localized: true },
        fields: [
          { type: "string", name: "siteName" },
          { type: "email", name: "contact", localized: false },
        ],
      },
      // Relations to the users-permissions user (user-relation-vectors.json): populated only for a
      // caller who may read users, as Strapi does.
      {
        name: "Review",
        kind: "collection",
        names: { plural: "Reviews" },
        fields: [
          { type: "string", name: "title", required: true },
          { type: "relation", name: "reviewer", relationKind: "manyToOne", target: "User" },
          { type: "relation", name: "readers", relationKind: "manyToMany", target: "User" },
        ],
      },
      // Relation targets for Book: a to-one with an inverse side, and a to-many without one.
      {
        name: "Author",
        kind: "collection",
        names: { plural: "Authors" },
        fields: [{ type: "string", name: "name", required: true }],
      },
      {
        name: "Genre",
        kind: "collection",
        names: { plural: "Genres" },
        fields: [{ type: "string", name: "name", required: true }],
      },
      // Every scalar kind Strapi's REST filters cast differently, plus an embedded and a
      // repeatable component: the type the REST query vectors (rest-query-vectors.json) run on. Its
      // relations are what the populate vectors (populate-vectors.json) run on.
      {
        name: "Book",
        kind: "collection",
        names: { plural: "Books" },
        fields: [
          { type: "string", name: "title", required: true },
          { type: "integer", name: "pages" },
          { type: "float", name: "rating" },
          { type: "boolean", name: "inStock" },
          { type: "date", name: "publishedOn" },
          { type: "dateTime", name: "releasedAt" },
          { type: "component", name: "price", component: "Money", repeatable: false },
          { type: "component", name: "editions", component: "Quantity", repeatable: true },
          {
            type: "relation",
            name: "author",
            relationKind: "manyToOne",
            target: "Author",
            inverse: "books",
          },
          { type: "relation", name: "genres", relationKind: "manyToMany", target: "Genre" },
          // A plain type linking a draft-and-publish one: it shows the target's published version.
          { type: "relation", name: "topic", relationKind: "manyToOne", target: "Topic" },
          // A plain type linking a localized one: it links the default locale.
          { type: "relation", name: "category", relationKind: "manyToOne", target: "Category" },
          { type: "media", name: "cover", allowedTypes: ["image"] },
          { type: "media", name: "attachments", multiple: true },
        ],
      },
    ],
    components: [
      // A dynamic zone's member (dynamic-zone-vectors.json), holding a nested component.
      {
        name: "Hero",
        fields: [
          { type: "string", name: "heading", required: true },
          { type: "text", name: "subheading" },
          { type: "component", name: "price", component: "Money", repeatable: false },
        ],
      },
      // An embedded component holding a repeatable one (transfer/read-vectors.json): its items
      // are child rows of the owning type, kept per version and locale.
      {
        name: "Panel",
        fields: [
          { type: "string", name: "heading" },
          { type: "component", name: "items", component: "Quantity", repeatable: true },
        ],
      },
      {
        name: "Money",
        fields: [
          { type: "bigInteger", name: "minor" },
          { type: "string", name: "currency" },
        ],
      },
      {
        name: "Quantity",
        fields: [
          { type: "decimal", name: "amount" },
          { type: "string", name: "unit" },
        ],
      },
    ],
  },
  roles: [
    {
      name: "authenticated",
      grants: [
        {
          contentType: "Note",
          actions: ["create", "read", "update", "delete"],
          condition: ownerEq,
          assign: { owner: "user.id" },
        },
        {
          contentType: "Transaction",
          actions: ["create", "read", "update", "delete"],
          condition: ownerEq,
          assign: { owner: "user.id" },
        },
        {
          contentType: "ActivitySession",
          actions: ["create", "read", "update", "delete"],
          condition: ownerEq,
          assign: { owner: "user.id" },
        },
        { contentType: "Activity", actions: ["read"], condition: publicOrMine },
        {
          contentType: "Activity",
          actions: ["create", "update", "delete"],
          condition: creatorEq,
          assign: { creator: "user.id" },
        },
        { contentType: "Tag", actions: ["read"] },
        // auth-vectors.json: the user list is readable; its writes are granted by the vectors' hook.
        { contentType: "User", actions: ["read"] },
        { contentType: "File", actions: ["create", "read", "update", "delete"] },
        { contentType: "Book", actions: ["create", "read", "update", "delete"] },
        { contentType: "Author", actions: ["create", "read", "update", "delete"] },
        { contentType: "Genre", actions: ["create", "read", "update", "delete"] },
        { contentType: "Topic", actions: ["create", "read", "update", "delete", "publish"] },
        { contentType: "Post", actions: ["create", "read", "update", "delete", "publish"] },
        { contentType: "Category", actions: ["create", "read", "update", "delete"] },
        { contentType: "Article", actions: ["create", "read", "update", "delete"] },
        { contentType: "Page", actions: ["create", "read", "update", "delete", "publish"] },
        { contentType: "Landing", actions: ["create", "read", "update", "delete", "publish"] },
        // A single type's create is Strapi's update: its one entry is made by the first put.
        { contentType: "Homepage", actions: ["read", "update", "delete", "publish"] },
        { contentType: "Global", actions: ["read", "update", "delete"] },
        { contentType: "Review", actions: ["create", "read", "update", "delete"] },
      ],
    },
    {
      // What a caller without a session may do (auth-vectors.json's public role, and the smoke).
      name: "public",
      grants: [
        { contentType: "Book", actions: ["read"] },
        { contentType: "Tag", actions: ["read"] },
        { contentType: "Activity", actions: ["read"], condition: publicOrMine },
        { contentType: "Review", actions: ["create", "read", "update", "delete"] },
      ],
    },
  ],
};
