import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { TS_MARKER } from "@camis/adapter-kernel";
import { importRouters } from "./router-config";
import { strapiAdapter } from "../generate";
import { customCodeDoc } from "../__fixtures__/custom-code";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "Address", kind: "collection", fields: [] },
    { name: "Article", kind: "collection", fields: [] },
    { name: "Homepage", kind: "single", fields: [] },
  ],
  components: [],
};

const router = (api: string, options: string, php = false) => ({
  path: `src/api/${api}/routes/${api}.${php ? "php" : "ts"}`,
  content: php
    ? `<?php\nuse Strapi\\Core\\Factories;\n\nreturn Factories::createCoreRouter('api::${api}.${api}', ${options});\n`
    : `import { factories } from '@strapi/strapi';\n\nexport default factories.createCoreRouter('api::${api}.${api}', ${options});\n`,
});

const features = (gaps: { feature: string; location: { file?: string } }[]) =>
  gaps.map((g) => [g.feature, g.location.file]);

describe("importRouters", () => {
  it("keeps the routes a core router's only or except leaves, in camis's action names", () => {
    const read = importRouters(
      [
        router("address", "['only' => ['find', 'findOne']]", true),
        router("article", "{ except: ['delete'] }"),
        router("homepage", "{ only: ['find'] }"),
      ],
      doc,
    );
    expect(read.apiActions).toEqual(
      new Map([
        ["Address", ["list", "read"]],
        ["Article", ["list", "read", "create", "update"]],
        ["Homepage", ["read"]],
      ]),
    );
    expect(read.gaps).toEqual([]);
  });

  it("leaves a type serving every action unrestricted", () => {
    const read = importRouters(
      [
        router("article", "{ except: [] }"),
        router("homepage", "{ only: ['find', 'update', 'delete'] }"),
      ],
      doc,
    );
    expect(read.apiActions).toEqual(new Map());
  });

  it("declares the project's own policies and middlewares an action's config names", () => {
    const read = importRouters(
      [
        router(
          "article",
          `{
            config: {
              update: { policies: ['global::is-owner'], middlewares: ['api::article.audit-trail'] },
              delete: { policies: ['global::is-owner'], middlewares: ['audit-trail'] },
              create: { middlewares: [{ name: 'api::article.audit-trail' }] },
            },
          }`,
        ),
        router(
          "homepage",
          "{ config: { find: { middlewares: ['global::cache-homepage'] }, update: { middlewares: ['global::cache-homepage'] }, delete: { middlewares: ['global::cache-homepage'] } } }",
        ),
      ],
      doc,
    );
    expect(read.policies).toEqual([
      { name: "IsOwner", contentType: "Article", actions: ["update", "delete"] },
    ]);
    expect(read.middlewares).toEqual([
      { name: "AuditTrail", contentType: "Article", actions: ["create", "update", "delete"] },
      { name: "CacheHomepage", contentType: "Homepage" },
    ]);
    expect(read.gaps).toEqual([]);
  });

  it("opens to anyone the actions whose route sets auth: false", () => {
    const read = importRouters(
      [
        router(
          "address",
          "['config' => ['find' => ['auth' => false], 'findOne' => ['auth' => false]]]",
          true,
        ),
        router(
          "article",
          "{ only: ['find', 'create'], config: { find: { auth: false }, create: { auth: true }, delete: { auth: false } } }",
        ),
        router("homepage", "{ config: { find: { auth: false } } }"),
      ],
      doc,
    );
    expect(read.publicApiActions).toEqual(
      new Map([
        ["Address", ["list", "read"]],
        ["Article", ["list"]],
        ["Homepage", ["read"]],
      ]),
    );
    expect(read.gaps).toEqual([]);
  });

  it("names a policy after its type too when two types use it", () => {
    const read = importRouters(
      [
        router("address", "{ config: { find: { policies: ['global::is-owner'] } } }"),
        router("article", "{ config: { find: { policies: ['global::is-owner'] } } }"),
      ],
      doc,
    );
    expect(read.policies.map((p) => p.name)).toEqual(["AddressIsOwner", "ArticleIsOwner"]);
  });

  it("reports what it cannot carry: a route's auth scope, inline or plugin code, a hook's config, a prefix", () => {
    const read = importRouters(
      [
        router(
          "article",
          `{
            prefix: '/v2',
            config: {
              find: { auth: { scope: ['api::article.article.find'] }, policies: ['plugin::users-permissions.isAuthenticated', (ctx) => true] },
              update: { policies: [{ name: 'global::is-owner', config: { field: 'author' } }] },
            },
          }`,
        ),
      ],
      doc,
    );
    expect(read.policies).toEqual([
      { name: "IsOwner", contentType: "Article", actions: ["update"] },
    ]);
    expect(read.gaps.map((g) => [g.feature, g.location.contentType, g.message])).toEqual([
      ["routePrefix", "Article", expect.stringContaining('"/v2"')],
      ["routeAuth", "Article", expect.stringContaining("find")],
      [
        "pluginPolicy",
        "Article",
        expect.stringContaining("plugin::users-permissions.isAuthenticated"),
      ],
      ["inlinePolicy", "Article", expect.stringContaining("find")],
      ["routeHookConfig", "Article", expect.stringContaining("global::is-owner")],
    ]);
    expect(read.gaps.every((g) => g.location.file === "src/api/article/routes/article.ts")).toBe(
      true,
    );
  });

  it("reports a router it cannot read whole as the router's config, and passes over camis's own", () => {
    const read = importRouters(
      [
        router("article", "{ only: ROUTES }"),
        router("unknown", "{}"),
        {
          ...router("address", "{ only: ['find'] }"),
          content: `${TS_MARKER}\n${router("address", "{ only: ['find'] }").content}`,
        },
        { path: "src/api/article/routes/custom.ts", content: "export default { routes: [] };" },
      ],
      doc,
    );
    expect(features(read.gaps)).toEqual([
      ["routeConfig", "src/api/article/routes/article.ts"],
      ["routeConfig", "src/api/unknown/routes/unknown.ts"],
    ]);
    expect(read.apiActions).toEqual(new Map());
  });
});

describe("importRouters round trip", () => {
  it("reads back the routes, policies and middlewares the Strapi target writes", () => {
    const doc = {
      ...customCodeDoc,
      contentTypes: customCodeDoc.contentTypes.map((ct) =>
        ct.kind === "single"
          ? ct
          : {
              ...ct,
              options: {
                ...ct.options,
                apiActions: [
                  "list" as const,
                  "read" as const,
                  "update" as const,
                  "delete" as const,
                ],
                publicApiActions: ["list" as const, "read" as const],
              },
            },
      ),
      middlewares: customCodeDoc.middlewares!.map((m) =>
        m.name === "AuditTrail" ? { ...m, actions: ["update" as const, "delete" as const] } : m,
      ),
    };
    const files = strapiAdapter
      .generate({ document: doc, roles: [] }, { projectName: "blog" })
      .files.filter((f) => f.path.includes("/routes/"))
      // Read as a project's own router, as a hand-written one is.
      .map((f) => ({ path: f.path, content: f.content.replace(TS_MARKER, "") }));
    const read = importRouters(files, doc);
    expect(read.gaps).toEqual([]);
    expect(read.apiActions).toEqual(new Map([["Article", ["list", "read", "update", "delete"]]]));
    expect(read.publicApiActions).toEqual(new Map([["Article", ["list", "read"]]]));
    expect(read.policies).toEqual(doc.policies);
    expect(read.middlewares).toEqual(doc.middlewares);
  });
});
