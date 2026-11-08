import { describe, expect, it } from "vitest";
import { customCodeGaps } from "./custom-code";

const V5_DEFAULT_CONTROLLER = `/**
 * article controller
 */

import { factories } from '@strapi/strapi'

export default factories.createCoreController('api::article.article');
`;

const V4_DEFAULT_SERVICE = `'use strict';

/**
 * article service
 */

const { createCoreService } = require('@strapi/strapi').factories;

module.exports = createCoreService('api::article.article');
`;

const DEFAULT_ROUTER = `import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::article.article');
`;

const DEFAULT_INDEX = `import type { Core } from '@strapi/strapi';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   */
  bootstrap(/* { strapi }: { strapi: Core.Strapi } */) {},
};
`;

const features = (files: { path: string; content: string }[]) =>
  customCodeGaps(files).map((g) => [g.feature, g.location.file]);

describe("customCodeGaps", () => {
  it("passes over the files a new Strapi project starts with", () => {
    expect(
      features([
        { path: "src/api/article/controllers/article.ts", content: V5_DEFAULT_CONTROLLER },
        { path: "src/api/article/services/article.js", content: V4_DEFAULT_SERVICE },
        { path: "src/api/article/routes/article.ts", content: DEFAULT_ROUTER },
        { path: "src/index.ts", content: DEFAULT_INDEX },
        { path: "src/admin/app.example.tsx", content: "export default { config: {} };" },
        { path: "src/admin/vite.config.example.ts", content: "export default {};" },
      ]),
    ).toEqual([]);
  });

  it("names each file of custom code a migration leaves behind, and what to do with it", () => {
    const gaps = customCodeGaps([
      {
        path: "src/api/article/controllers/article.ts",
        content: `import { factories } from '@strapi/strapi';
export default factories.createCoreController('api::article.article', ({ strapi }) => ({
  async find(ctx) { return super.find(ctx); },
}));`,
      },
      {
        path: "src/api/article/services/article.ts",
        content: `export default factories.createCoreService('api::article.article', () => ({ x() {} }));`,
      },
      {
        path: "src/api/article/routes/article.ts",
        content: `export default factories.createCoreRouter('api::article.article', {
  config: { update: { policies: ['global::is-owner'] } },
});`,
      },
      {
        path: "src/api/article/routes/01-custom.ts",
        content: `export default { routes: [{ method: 'GET', path: '/articles/featured', handler: 'article.featured' }] };`,
      },
      { path: "src/api/article/policies/is-draft.ts", content: "export default () => true;" },
      { path: "src/policies/is-owner.js", content: "module.exports = () => true;" },
      {
        path: "src/api/article/middlewares/audit.ts",
        content: "export default () => async (ctx, next) => next();",
      },
      {
        path: "src/middlewares/timer.ts",
        content: "export default () => async (ctx, next) => next();",
      },
      {
        path: "src/api/article/content-types/article/lifecycles.ts",
        content: "export default { beforeCreate(event) {} };",
      },
      {
        path: "config/cron-tasks.ts",
        content: "export default { digest: { task() {}, options: { rule: '0 7 * * *' } } };",
      },
      {
        path: "src/index.ts",
        content: `export default { register() {}, bootstrap({ strapi }) { strapi.log.info('hi'); } };`,
      },
      {
        path: "src/extensions/users-permissions/strapi-server.ts",
        content: "export default (plugin) => plugin;",
      },
      { path: "src/plugins/my-plugin/package.json", content: "{}" },
      { path: "src/plugins/my-plugin/server/index.js", content: "module.exports = {};" },
      { path: "src/admin/app.tsx", content: "export default { config: { locales: ['fr'] } };" },
    ]);
    expect(gaps.map((g) => [g.feature, g.location.file])).toEqual([
      ["cronTasks", "config/cron-tasks.ts"],
      ["adminCustomization", "src/admin/app.tsx"],
      ["lifecycles", "src/api/article/content-types/article/lifecycles.ts"],
      ["customController", "src/api/article/controllers/article.ts"],
      ["customMiddleware", "src/api/article/middlewares/audit.ts"],
      ["customPolicy", "src/api/article/policies/is-draft.ts"],
      ["customRoutes", "src/api/article/routes/01-custom.ts"],
      ["routeConfig", "src/api/article/routes/article.ts"],
      ["customService", "src/api/article/services/article.ts"],
      ["pluginExtension", "src/extensions/users-permissions/strapi-server.ts"],
      ["bootstrap", "src/index.ts"],
      ["customMiddleware", "src/middlewares/timer.ts"],
      ["localPlugin", "src/plugins/my-plugin"],
      ["customPolicy", "src/policies/is-owner.js"],
    ]);
    expect(gaps.every((g) => g.severity === "downgrade")).toBe(true);
    expect(gaps.find((g) => g.feature === "lifecycles")!.message).toBe(
      "lifecycle code is not imported; declare each lifecycle as an IR hook (beforeCreate, afterCreate, beforeUpdate, afterUpdate, beforeDelete or afterDelete) and port its code into the seeded hook class",
    );
  });

  it("reads a strapi-php project's PHP files the same way", () => {
    const php = (body: string) =>
      `<?php\n\ndeclare(strict_types=1);\n\n/**\n * doc\n */\n\nuse Strapi\\Core\\Factories;\n\n${body}\n`;
    expect(
      features([
        {
          path: "src/api/category/controllers/category.php",
          content: php("return Factories::createCoreController('api::category.category');"),
        },
        {
          path: "src/api/category/services/category.php",
          content: php("return Factories::createCoreService('api::category.category');"),
        },
        {
          path: "src/api/category/routes/category.php",
          content: php("return Factories::createCoreRouter('api::category.category');"),
        },
        {
          path: "src/index.php",
          content: php(`return [
    'register' => static function (Strapi $strapi): void {
        // $strapi->log()->info('register');
    },
    'bootstrap' => static function (Strapi $strapi): void {
    },
];`),
        },
      ]),
    ).toEqual([]);
    expect(
      features([
        {
          path: "src/api/address/routes/address.php",
          content: php(
            "return Factories::createCoreRouter('api::address.address', ['only' => ['find']]);",
          ),
        },
        {
          path: "src/api/address/index.php",
          content: php(
            "return ['register' => static function (Strapi $strapi): void { $strapi->log()->info('x'); }];",
          ),
        },
        {
          path: "src/api/address/policies/address.php",
          content: php("return static fn (): bool => true;"),
        },
        {
          path: "src/custom/middleware.php",
          content: php("return static fn (): callable => $next;"),
        },
        { path: "config/src/cron-tasks.php", content: php("return [];") },
        {
          path: "config/server.php",
          content: php(
            "return static fn ($env): array => ['cron' => ['enabled' => true, 'tasks' => $cronTasks]];",
          ),
        },
      ]),
    ).toEqual(
      [
        ["bootstrap", "src/api/address/index.php"],
        ["customPolicy", "src/api/address/policies/address.php"],
        ["routeConfig", "src/api/address/routes/address.php"],
        ["customCode", "src/custom/middleware.php"],
        ["cronTasks", "config/src/cron-tasks.php"],
      ].sort((a, b) => (a[1]! < b[1]! ? -1 : 1)),
    );
  });

  it("counts every admin file but the examples a new project ships", () => {
    expect(
      features([
        { path: "src/admin/extensions/logo.tsx", content: "export default 1;" },
        { path: "src/admin/webpack.config.example.js", content: "module.exports = {};" },
      ]),
    ).toEqual([["adminCustomization", "src/admin/extensions/logo.tsx"]]);
  });

  it("passes over what camis itself generated", () => {
    expect(
      features([
        {
          path: "src/api/article/content-types/article/lifecycles.ts",
          content: "// @camis:generated — do not edit; regenerated by camis\nexport default {};",
        },
      ]),
    ).toEqual([]);
  });
});
