import { describe, expect, it } from "vitest";
import { TS_MARKER } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { importEndpoints } from "./endpoints";
import { strapiAdapter } from "../generate";
import { customCodeDoc } from "../__fixtures__/custom-code";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [] },
    { name: "Homepage", kind: "single", fields: [] },
  ],
  components: [],
};

const ts = (api: string, routes: string) => ({
  path: `src/api/${api}/routes/custom.ts`,
  content: `export default {\n  routes: ${routes},\n};\n`,
});
const php = (api: string, routes: string) => ({
  path: `src/api/${api}/routes/custom.php`,
  content: `<?php\n\nreturn ['routes' => ${routes}];\n`,
});

describe("importEndpoints", () => {
  it("declares each custom route as an endpoint of its API's content type", () => {
    const read = importEndpoints(
      [
        ts(
          "article",
          `[
            { method: 'POST', path: '/articles/:id/like', handler: 'article.like' },
            { method: 'get', path: '/articles/trending', handler: 'api::article.trending.find', config: { auth: false } },
          ]`,
        ),
        php(
          "homepage",
          "[['method' => 'GET', 'path' => '/homepage/preview', 'handler' => 'api::homepage.preview.handle']]",
        ),
      ],
      doc,
    );
    expect(read.endpoints).toEqual([
      { name: "ArticleLike", contentType: "Article", method: "POST", path: "/articles/:id/like" },
      {
        name: "TrendingFind",
        contentType: "Article",
        method: "GET",
        path: "/articles/trending",
        public: true,
      },
      { name: "Preview", contentType: "Homepage", method: "GET", path: "/homepage/preview" },
    ]);
    expect(read.read).toEqual(
      new Set(["src/api/article/routes/custom.ts", "src/api/homepage/routes/custom.php"]),
    );
    // Strapi keeps who may call a route in its database, which the import does not read.
    expect(read.gaps.map((g) => [g.feature, g.location.contentType])).toEqual([
      ["endpointRoles", "Article"],
      ["endpointRoles", "Homepage"],
    ]);
  });

  it("reports what an endpoint cannot carry, and a routes file it cannot read", () => {
    const read = importEndpoints(
      [
        ts(
          "article",
          `[
            { method: 'GET', path: '/articles/:id(\\\\d+)/stats', handler: 'article.stats', config: { auth: false } },
            { method: 'GET', path: '/articles/feed', handler: 'article.feed', config: { auth: false, policies: ['global::is-owner'], middlewares: ['api::article.cache'] } },
            { method: 'GET', path: '/articles/mine', handler: 'article.mine', config: { auth: { scope: ['x'] } } },
          ]`,
        ),
        ts("unknown", "[{ method: 'GET', path: '/x', handler: 'unknown.x' }]"),
        { path: "src/api/article/routes/more.ts", content: "export default { routes: ROUTES };" },
      ],
      doc,
    );
    expect(read.endpoints.map((e) => e.name)).toEqual(["ArticleFeed", "ArticleMine"]);
    expect(read.gaps.map((g) => [g.feature, g.location.file])).toEqual([
      ["endpointPath", "src/api/article/routes/custom.ts"],
      ["endpointHook", "src/api/article/routes/custom.ts"],
      ["routeAuth", "src/api/article/routes/custom.ts"],
      ["endpointRoles", "src/api/article/routes/custom.ts"],
      ["endpointContentType", "src/api/unknown/routes/custom.ts"],
    ]);
    // A file it cannot read is left to the custom code report.
    expect(read.read).toEqual(
      new Set(["src/api/article/routes/custom.ts", "src/api/unknown/routes/custom.ts"]),
    );
  });

  it("reads back the endpoints the Strapi target writes", () => {
    const files = strapiAdapter
      .generate({ document: customCodeDoc, roles: [] }, { projectName: "blog" })
      .files.filter((f) => f.path.endsWith("/routes/01-endpoints.ts"))
      .map((f) => ({ path: f.path, content: f.content.replace(TS_MARKER, "") }));
    expect(importEndpoints(files, customCodeDoc).endpoints).toEqual(customCodeDoc.endpoints);
  });

  it("passes over the routes files camis wrote and core routers", () => {
    const read = importEndpoints(
      [
        { ...ts("article", "[]"), content: `${TS_MARKER}\n${ts("article", "[]").content}` },
        {
          path: "src/api/article/routes/article.ts",
          content: "export default factories.createCoreRouter('api::article.article');",
        },
      ],
      doc,
    );
    expect(read).toEqual({ endpoints: [], gaps: [], read: new Set() });
  });
});
