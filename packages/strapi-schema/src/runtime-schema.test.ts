import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { runtimeSchemas } from "./runtime-schema";

// The schemas a running Strapi 5 holds, as `strapi export` writes them to an archive's
// schemas/*.jsonl: schema.json plus what Strapi adds on load. Shapes recorded from strapi-php's
// export (packages/adapter-filament/src/strapi-api/__fixtures__/transfer).
const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "User",
      kind: "collection",
      builtin: "user",
      fields: [{ type: "string", name: "username", required: true }],
    },
    {
      name: "BlogPost",
      kind: "collection",
      names: { plural: "BlogPosts", collection: "blog_posts" },
      fields: [
        { type: "string", name: "title" },
        { type: "component", name: "price", component: "Money" },
        {
          type: "relation",
          name: "owner",
          relationKind: "manyToOne",
          target: "User",
          inverse: "posts",
        },
      ],
    },
    {
      name: "Page",
      kind: "collection",
      fields: [{ type: "string", name: "title" }],
      options: { draftPublish: true, localized: true },
    },
  ],
  components: [{ name: "Money", fields: [{ type: "string", name: "currency" }] }],
} as IrDocument;

const schemas = runtimeSchemas(doc);
const byUid = new Map(schemas.map((s) => [s.uid, s]));

describe("runtimeSchemas", () => {
  it("lists Strapi's plugin types, the project's, the admin's, then components", () => {
    expect(schemas.map((s) => s.uid)).toEqual([
      "plugin::upload.file",
      "plugin::upload.folder",
      "plugin::i18n.locale",
      "plugin::users-permissions.permission",
      "plugin::users-permissions.role",
      "plugin::users-permissions.user",
      "api::blog-post.blog-post",
      "api::page.page",
      "admin::permission",
      "admin::user",
      "admin::role",
      "admin::api-token",
      "admin::api-token-permission",
      "admin::transfer-token",
      "admin::transfer-token-permission",
      "admin::session",
      "shared.money",
    ]);
  });

  it("adds Strapi's system attributes and model keys to a content type", () => {
    const post = byUid.get("api::blog-post.blog-post")!;
    expect(Object.keys(post)).toEqual([
      "collectionName",
      "info",
      "options",
      "pluginOptions",
      "attributes",
      "kind",
      "modelType",
      "modelName",
      "uid",
      "globalId",
    ]);
    expect(post).toMatchObject({
      collectionName: "blog_posts",
      options: { draftAndPublish: false },
      pluginOptions: {},
      kind: "collectionType",
      modelType: "contentType",
      modelName: "blog-post",
      globalId: "BlogPost",
    });
    expect(post.attributes).toEqual({
      title: { type: "string" },
      price: { type: "component", component: "shared.money", repeatable: false },
      owner: {
        type: "relation",
        relation: "manyToOne",
        target: "plugin::users-permissions.user",
        inversedBy: "posts",
      },
      createdAt: { type: "datetime" },
      updatedAt: { type: "datetime" },
      publishedAt: { type: "datetime", configurable: false, writable: true, visible: true },
      createdBy: {
        type: "relation",
        relation: "oneToOne",
        target: "admin::user",
        configurable: false,
        writable: false,
        visible: false,
        useJoinTable: false,
        private: true,
      },
      updatedBy: {
        type: "relation",
        relation: "oneToOne",
        target: "admin::user",
        configurable: false,
        writable: false,
        visible: false,
        useJoinTable: false,
        private: true,
      },
      locale: {
        writable: true,
        private: true,
        configurable: false,
        visible: false,
        type: "string",
      },
      localizations: {
        type: "relation",
        relation: "oneToMany",
        target: "api::blog-post.blog-post",
        writable: false,
        private: true,
        configurable: false,
        visible: false,
        unstable_virtual: true,
        joinColumn: {
          name: "document_id",
          referencedColumn: "document_id",
          referencedTable: "blog_posts",
        },
      },
    });
  });

  it("makes a localized type's locale and localizations public", () => {
    const page = byUid.get("api::page.page")!;
    const attributes = page.attributes as Record<string, Record<string, unknown>>;
    expect(page.options).toEqual({ draftAndPublish: true });
    expect(page.pluginOptions).toEqual({ i18n: { localized: true } });
    expect(attributes.locale?.private).toBe(false);
    expect(attributes.localizations?.private).toBe(false);
  });

  it("gives Strapi's user the inverse attributes the IR names on it", () => {
    const user = byUid.get("plugin::users-permissions.user")!;
    expect((user.attributes as Record<string, unknown>).posts).toEqual({
      type: "relation",
      relation: "oneToMany",
      target: "api::blog-post.blog-post",
      mappedBy: "owner",
    });
  });

  it("names a component's model after its category", () => {
    expect(byUid.get("shared.money")).toEqual({
      collectionName: "components_shared_money",
      info: { displayName: "Money" },
      options: {},
      pluginOptions: {},
      attributes: { currency: { type: "string" } },
      modelType: "component",
      modelName: "money",
      uid: "shared.money",
      globalId: "ComponentSharedMoney",
    });
  });
});
