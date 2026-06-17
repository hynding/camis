// Strapi v5 project skeleton templates.
// Captured from a running Strapi 5.47.1 project (oyl/apps/strapi-oyl) on 2026-06-15.
// config/database.ts authored to target sqlite; all other configs match Strapi v5 defaults.

const STRAPI_VERSION = "5.47.1";

export const packageJson = (projectName: string): string =>
  JSON.stringify(
    {
      name: projectName,
      private: true,
      version: "0.1.0",
      description: "A Strapi application",
      scripts: {
        develop: "strapi develop",
        start: "strapi start",
        build: "strapi build",
        deploy: "strapi deploy",
        strapi: "strapi",
      },
      dependencies: {
        "@strapi/strapi": STRAPI_VERSION,
        "@strapi/plugin-users-permissions": STRAPI_VERSION,
        "@strapi/plugin-i18n": STRAPI_VERSION,
        better_sqlite3: "9.4.3",
        react: "18.3.1",
        "react-dom": "18.3.1",
        "react-router-dom": "6.26.2",
        "styled-components": "6.1.13",
      },
      devDependencies: {
        "@strapi/typescript-utils": STRAPI_VERSION,
        "@types/node": "22.5.4",
        typescript: "5.6.2",
      },
      engines: {
        node: ">=18.0.0 <=22.x.x",
        npm: ">=6.0.0",
      },
    },
    null,
    2,
  );

export const TSCONFIG_JSON = JSON.stringify(
  {
    extends: "@strapi/typescript-utils/tsconfigs/server",
    compilerOptions: {
      outDir: "dist",
      rootDir: ".",
    },
    include: ["./", "src/**/*.json"],
    exclude: [
      "node_modules/",
      "build/",
      "dist/",
      ".cache/",
      ".tmp/",
      "src/admin/",
      "**/*.test.ts",
      "src/plugins/**",
    ],
  },
  null,
  2,
);

export const SERVER_TS = `import { defineConfig } from "@strapi/strapi";

export default defineConfig({
  // Host: process.env.HOST || "0.0.0.0",
  // Port: parseInt(process.env.PORT || "1337"),
});
`;

export const ADMIN_TS = `import { defineConfig } from "@strapi/strapi";

export default defineConfig({
  // Add custom admin panel configuration here.
  // auth: { secret: process.env.ADMIN_JWT_SECRET },
});
`;

export const API_TS = `import { defineConfig } from "@strapi/strapi";

export default defineConfig({
  rest: {
    defaultLimit: 25,
    maxLimit: 100,
    withCount: true,
  },
});
`;

export const MIDDLEWARES_TS = `export default [
  "strapi::logger",
  "strapi::errors",
  "strapi::security",
  "strapi::cors",
  "strapi::poweredBy",
  "strapi::query",
  "strapi::body",
  "strapi::session",
  "strapi::favicon",
  "strapi::public",
];
`;

export const DATABASE_TS = `import path from "path";

const databaseFilename = process.env["DATABASE_FILENAME"] ?? ".tmp/data.db";

export default () => ({
  connection: {
    client: "sqlite",
    connection: {
      filename: path.join(__dirname, "..", databaseFilename),
    },
    useNullAsDefault: true,
  },
});
`;

export const SRC_INDEX_TS = `export default {
  /**
   * An asynchronous register function that runs before
   * your application gets registered.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap(/* { strapi } */) {},
};
`;

export const ENV = `APP_KEYS=camisDevKeyA,camisDevKeyB
API_TOKEN_SALT=camisDevApiTokenSalt
ADMIN_JWT_SECRET=camisDevAdminJwtSecret
TRANSFER_TOKEN_SALT=camisDevTransferTokenSalt
JWT_SECRET=camisDevJwtSecret
`;
