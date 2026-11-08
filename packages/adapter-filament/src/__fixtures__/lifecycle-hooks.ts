import type { IrBundle } from "@camis/permissions";

// Every lifecycle trigger on one content type, beside an onPublish hook: one observer runs them all.
export const lifecycleHooksBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "string", name: "slug" },
          { type: "dateTime", name: "publishedAt" },
        ],
      },
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
        input: [
          { name: "title", type: "string" },
          { name: "slug", type: "string" },
        ],
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
  },
  roles: [],
};
