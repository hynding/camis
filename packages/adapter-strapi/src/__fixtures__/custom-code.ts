import type { IrDocument } from "@camis/ir-schema";

// Every kind of hand-written code the IR declares: lifecycle hooks beside an onPublish one, route
// policies and middlewares, schedules, and endpoints.
export const customCodeDoc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      options: { draftPublish: true },
      fields: [
        { type: "string", name: "title", required: true },
        { type: "string", name: "slug" },
      ],
    },
    { name: "Homepage", kind: "single", fields: [{ type: "string", name: "headline" }] },
  ],
  components: [],
  hooks: [
    {
      name: "TransformTitle",
      trigger: "onPublish",
      contentType: "Article",
      input: [{ name: "title", type: "string" }],
      output: [{ name: "title", type: "string" }],
    },
    {
      name: "Slugify",
      trigger: "beforeCreate",
      contentType: "Article",
      input: [{ name: "title", type: "string" }],
      output: [{ name: "slug", type: "string" }],
    },
    {
      name: "Reslug",
      trigger: "beforeUpdate",
      contentType: "Article",
      input: [{ name: "title", type: "string" }],
      output: [{ name: "slug", type: "string" }],
    },
    {
      name: "AnnounceArticle",
      trigger: "afterCreate",
      contentType: "Article",
      input: [{ name: "title", type: "string" }],
      output: [],
    },
    {
      name: "ReindexArticle",
      trigger: "afterUpdate",
      contentType: "Article",
      input: [{ name: "slug", type: "string" }],
      output: [],
    },
    {
      name: "GuardDelete",
      trigger: "beforeDelete",
      contentType: "Article",
      input: [{ name: "slug", type: "string" }],
      output: [],
    },
    {
      name: "ForgetArticle",
      trigger: "afterDelete",
      contentType: "Article",
      input: [{ name: "slug", type: "string" }],
      output: [],
    },
  ],
  policies: [{ name: "IsOwner", contentType: "Article", actions: ["update", "delete"] }],
  middlewares: [
    { name: "AuditTrail", contentType: "Article", actions: ["create", "update", "delete"] },
    { name: "CacheHomepage", contentType: "Homepage" },
  ],
  schedules: [
    { name: "SendDigest", cron: "0 7 * * 1-5" },
    { name: "PruneDrafts", cron: "*/30 * * * *" },
  ],
  endpoints: [
    { name: "ArticleLike", contentType: "Article", method: "POST", path: "/articles/:id/like" },
    {
      name: "ArticleTrending",
      contentType: "Article",
      method: "GET",
      path: "/articles/trending",
      public: true,
    },
  ],
};
