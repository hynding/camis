import type { GeneratedFile } from "@camis/adapter-kernel";
import {
  ADMIN_TS,
  API_TS,
  DATABASE_TS,
  ENV,
  MIDDLEWARES_TS,
  serverTs,
  SRC_INDEX_TS,
  TSCONFIG_JSON,
  packageJson,
} from "./skeleton/templates";

export const skeletonFiles = (
  projectName: string,
  { cron = false, plugins = [] }: { cron?: boolean; plugins?: readonly string[] } = {},
): GeneratedFile[] => [
  { path: "package.json", content: packageJson(projectName, plugins) },
  { path: "tsconfig.json", content: TSCONFIG_JSON },
  { path: "config/server.ts", content: serverTs(cron) },
  { path: "config/admin.ts", content: ADMIN_TS },
  { path: "config/api.ts", content: API_TS },
  { path: "config/middlewares.ts", content: MIDDLEWARES_TS },
  { path: "config/database.ts", content: DATABASE_TS },
  { path: "src/index.ts", content: SRC_INDEX_TS },
  { path: ".env", content: ENV, mode: "seed" },
  // Strapi's local upload provider fails to register if public/uploads is absent; the folder is
  // runtime data, so it is seeded once and never rewritten.
  { path: "public/uploads/.gitkeep", content: "", mode: "seed" },
];
