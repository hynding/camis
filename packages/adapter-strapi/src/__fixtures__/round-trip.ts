import type { IrDocument } from "@camis/ir-schema";

// Only round-trippable features: PascalCase names, scalars, a bidirectional relation,
// a component, media. No softDelete/timestamps/dynamicZone/acronyms.
export const roundTrip: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "string", name: "title", required: true },
        { type: "uid", name: "slug", targetField: "title" },
        { type: "richText", name: "body" },
        { type: "enumeration", name: "status", values: ["draft", "published"], default: "draft" },
        { type: "media", name: "cover", multiple: false, allowedTypes: ["image"] },
        {
          type: "relation",
          name: "author",
          relationKind: "manyToOne",
          target: "Author",
          inverse: "articles",
        },
        { type: "component", name: "seo", component: "SeoMeta", repeatable: false },
      ],
      options: { draftPublish: true },
    },
    {
      name: "Author",
      kind: "collection",
      fields: [{ type: "string", name: "name", required: true }],
    },
  ],
  components: [{ name: "SeoMeta", fields: [{ type: "string", name: "metaTitle" }] }],
};
