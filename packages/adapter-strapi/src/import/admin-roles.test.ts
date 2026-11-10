import type { IrDocument } from "@camis/ir-schema";
import { describe, expect, it } from "vitest";
import { adminRoleName, importStrapiAdminRoles, type StrapiAdminData } from "./admin-roles";

// Rows as a Strapi 5 database holds them: admin_roles, admin_permissions (properties and
// conditions are JSON) linked to their role, and the i18n locales.
const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      options: { draftPublish: true, i18n: true },
      fields: [
        { type: "string", name: "title", localized: true },
        { type: "text", name: "body", localized: true },
      ],
    },
    { name: "Homepage", kind: "single", fields: [{ type: "string", name: "title" }] },
  ],
  components: [],
};

const SUPER_ADMIN = { id: 1, name: "Super Admin", code: "strapi-super-admin", description: "" };
const EDITOR = {
  id: 2,
  name: "Editor",
  code: "strapi-editor",
  description: "Editors can manage and publish contents including those of other users.",
};

const cm = (action: string, subject: string, properties: unknown = {}, conditions: unknown = []) => ({
  action: `plugin::content-manager.explorer.${action}`,
  subject,
  properties,
  conditions,
});

const data = (
  roles: StrapiAdminData["roles"],
  permissions: StrapiAdminData["permissions"],
  locales = ["en", "fr"],
): StrapiAdminData => ({ roles, permissions, locales });

const ARTICLE = "api::article.article";
const FULL = { fields: ["title", "body"], locales: ["en", "fr"] };

describe("importStrapiAdminRoles", () => {
  it("brings an admin role in as an admin role holding the content-manager actions it was given", () => {
    const imported = importStrapiAdminRoles(
      data(
        [SUPER_ADMIN, EDITOR],
        [
          { role: 2, ...cm("create", ARTICLE, FULL) },
          { role: 2, ...cm("read", ARTICLE, FULL) },
          { role: 2, ...cm("update", ARTICLE, FULL) },
          { role: 2, ...cm("delete", ARTICLE, { locales: ["en", "fr"] }) },
          { role: 2, ...cm("publish", ARTICLE, { locales: ["fr", "en"] }) },
          { role: 2, ...cm("read", "api::homepage.homepage", { fields: ["title"] }) },
        ],
      ),
      doc,
    );
    expect(imported.roles).toEqual([
      {
        name: "editor",
        description: "Editors can manage and publish contents including those of other users.",
        admin: true,
        grants: [
          { contentType: "Article", actions: ["create", "read", "update", "delete", "publish"] },
          { contentType: "Homepage", actions: ["read"] },
        ],
      },
    ]);
    expect(imported.gaps).toEqual([]);
  });

  it("leaves Strapi's Super Admin to the IR's super-admin, which may do everything", () => {
    const imported = importStrapiAdminRoles(
      data([SUPER_ADMIN], [{ role: 1, ...cm("read", ARTICLE, FULL) }]),
      doc,
    );
    expect(imported.roles).toEqual([]);
    expect(imported.superAdmin).toBe(true);
  });

  it("grants the media library and the users through their own actions", () => {
    const imported = importStrapiAdminRoles(
      data(
        [EDITOR],
        [
          { role: 2, action: "plugin::upload.read", subject: null, properties: {}, conditions: [] },
          { role: 2, action: "plugin::upload.assets.download", subject: null, properties: {}, conditions: [] },
          { role: 2, action: "plugin::upload.assets.copy-link", subject: null, properties: {}, conditions: [] },
          { role: 2, action: "plugin::upload.assets.create", subject: null, properties: {}, conditions: [] },
          { role: 2, action: "plugin::upload.assets.update", subject: null, properties: {}, conditions: [] },
          { role: 2, ...cm("read", "plugin::users-permissions.user", { fields: ["username", "email"] }) },
        ],
      ),
      doc,
    );
    expect(imported.roles[0]?.grants).toEqual([
      { contentType: "File", actions: ["create", "read", "update", "delete"] },
      { contentType: "User", actions: ["read"] },
    ]);
    expect(imported.document.contentTypes.map((ct) => [ct.name, ct.builtin])).toEqual([
      ["Article", undefined],
      ["Homepage", undefined],
      ["File", "file"],
      ["User", "user"],
    ]);
  });

  it("never grants more than Strapi did: a condition, some fields or some locales leave the action out", () => {
    const AUTHOR = { id: 3, name: "Author", code: "strapi-author", description: "" };
    const imported = importStrapiAdminRoles(
      data(
        [AUTHOR],
        [
          { role: 3, ...cm("create", ARTICLE, FULL) },
          { role: 3, ...cm("read", ARTICLE, FULL, ["admin::is-creator"]) },
          { role: 3, ...cm("update", ARTICLE, { fields: ["title"], locales: ["en", "fr"] }) },
          { role: 3, ...cm("delete", ARTICLE, { locales: ["en"] }) },
        ],
      ),
      doc,
    );
    expect(imported.roles[0]?.grants).toEqual([{ contentType: "Article", actions: ["create"] }]);
    expect(imported.gaps.map((g) => g.message)).toEqual([
      'admin role "author": plugin::content-manager.explorer.read on Article holds only when admin::is-creator; a camis grant has no such condition, so it is not granted',
      'admin role "author": plugin::content-manager.explorer.update on Article covers only the fields title; a camis grant covers every field, so it is not granted',
      'admin role "author": plugin::content-manager.explorer.delete on Article covers only the locales en; a camis grant covers every locale, so it is not granted',
    ]);
    expect(imported.gaps[0]).toMatchObject({
      feature: "strapiAdminPermission",
      severity: "downgrade",
      location: { contentType: "Article", rule: "author" },
    });
  });

  it("reports the settings and plugin actions, and a type this project lacks, in one line each", () => {
    const imported = importStrapiAdminRoles(
      data(
        [EDITOR],
        [
          { role: 2, ...cm("read", "api::gone.gone", {}) },
          { role: 2, action: "admin::users.read", subject: null, properties: {}, conditions: [] },
          { role: 2, action: "plugin::content-type-builder.read", subject: null, properties: {}, conditions: [] },
        ],
      ),
      doc,
    );
    expect(imported.roles[0]?.grants).toEqual([]);
    expect(imported.gaps.map((g) => g.message)).toEqual([
      'admin role "editor": plugin::content-manager.explorer.read on api::gone.gone: this project has no such type, so it is not granted',
      'admin role "editor": admin::users.read, plugin::content-type-builder.read: settings and plugin actions are not imported; in camis the Settings pages follow the role\'s grants on the User type',
    ]);
  });

  it("names a custom role after Strapi's name, kept apart from the users' roles", () => {
    const imported = importStrapiAdminRoles(
      data(
        [
          { id: 4, name: "Content Writer", code: "content-writer-m3k2", description: "" },
          { id: 5, name: "Authenticated", code: "authenticated-m3k3", description: "" },
        ],
        [],
      ),
      doc,
      ["public", "authenticated"],
    );
    expect(imported.roles.map((r) => r.name)).toEqual(["content-writer", "admin-authenticated"]);
    expect(imported.roles[0]).not.toHaveProperty("description");
  });
});

describe("adminRoleName", () => {
  it("is the role's name in kebab case, else one made of its id", () => {
    expect(adminRoleName("Editor", 2)).toBe("editor");
    expect(adminRoleName("  SEO & Marketing ", 7)).toBe("seo-marketing");
    expect(adminRoleName("编辑", 9)).toBe("admin-role-9");
  });
});
