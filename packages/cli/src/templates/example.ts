import type { IrDocument } from "@camis/ir-schema";
import type { Grant } from "@camis/permissions";
import { strapiDefaultRoles, type ProjectTemplate } from "./project-template";

const ANY_MEDIA = ["image", "file", "video"] as const;

const names = (display: string, plural: string, collection: string) => ({
  display,
  plural,
  collection,
});

const group = (collection: string) => ({ collection, group: "shared" });

/**
 * create-strapi-app's `--example` blog, as the Strapi importer reads it. Upstream's `blocks`
 * dynamic zones on Article and About are left out: no target generates dynamic zones yet, so
 * every build of a fresh project would warn about them.
 */
const document: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      names: names("Article", "Articles", "articles"),
      fields: [
        { type: "string", name: "title" },
        { type: "text", name: "description", maxLength: 80 },
        { type: "uid", name: "slug", targetField: "title" },
        { type: "media", name: "cover", multiple: false, allowedTypes: [...ANY_MEDIA] },
        {
          type: "relation",
          name: "author",
          relationKind: "manyToOne",
          target: "Author",
          inverse: "articles",
        },
        {
          type: "relation",
          name: "category",
          relationKind: "manyToOne",
          target: "Category",
          inverse: "articles",
        },
      ],
      options: { draftPublish: true },
    },
    {
      name: "Author",
      kind: "collection",
      names: names("Author", "Authors", "authors"),
      fields: [
        { type: "string", name: "name" },
        { type: "media", name: "avatar", multiple: false, allowedTypes: [...ANY_MEDIA] },
        { type: "string", name: "email" },
      ],
      options: { draftPublish: false },
    },
    {
      name: "Category",
      kind: "collection",
      names: names("Category", "Categories", "categories"),
      fields: [
        { type: "string", name: "name" },
        { type: "uid", name: "slug" },
        { type: "text", name: "description" },
      ],
      options: { draftPublish: false },
    },
    {
      name: "About",
      kind: "single",
      names: names("About", "Abouts", "abouts"),
      fields: [{ type: "string", name: "title" }],
      options: { draftPublish: false },
    },
    {
      name: "Global",
      kind: "single",
      names: names("Global", "Globals", "globals"),
      fields: [
        { type: "string", name: "siteName", required: true },
        { type: "media", name: "favicon", multiple: false, allowedTypes: [...ANY_MEDIA] },
        { type: "text", name: "siteDescription", required: true },
        { type: "component", name: "defaultSeo", component: "Seo", repeatable: false },
      ],
      options: { draftPublish: false },
    },
  ],
  components: [
    {
      name: "Media",
      names: group("components_shared_media"),
      fields: [{ type: "media", name: "file", multiple: false, allowedTypes: [...ANY_MEDIA] }],
    },
    {
      name: "Quote",
      names: group("components_shared_quotes"),
      fields: [
        { type: "string", name: "title" },
        { type: "text", name: "body" },
      ],
    },
    {
      name: "RichText",
      names: group("components_shared_rich_texts"),
      fields: [{ type: "richText", name: "body" }],
    },
    {
      name: "Seo",
      names: group("components_shared_seos"),
      fields: [
        { type: "string", name: "metaTitle", required: true },
        { type: "text", name: "metaDescription", required: true },
        { type: "media", name: "shareImage", multiple: false, allowedTypes: ["image"] },
      ],
    },
    {
      name: "Slider",
      names: group("components_shared_sliders"),
      fields: [{ type: "media", name: "files", multiple: true, allowedTypes: ["image"] }],
    },
  ],
};

// Upstream's example seeds find/findOne on every content type for the public role.
const publicRead: Grant[] = document.contentTypes.map((ct) => ({
  contentType: ct.name,
  actions: ["read"],
}));

export const exampleTemplate: ProjectTemplate = {
  document,
  roles: strapiDefaultRoles(publicRead),
};
