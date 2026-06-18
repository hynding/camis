import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { expressNames } from "./names";

const PACKAGE_JSON = (projectName: string): string =>
  JSON.stringify(
    {
      name: projectName,
      private: true,
      type: "module",
      scripts: {
        dev: "tsx watch src/index.ts",
        start: "tsx src/index.ts",
        "db:push": "drizzle-kit push",
      },
      dependencies: { "better-sqlite3": "^11.8.0", "drizzle-orm": "^0.38.0", express: "^4.21.0" },
      devDependencies: {
        "@types/better-sqlite3": "^7.6.0",
        "@types/express": "^4.17.0",
        "@types/node": "^22.0.0",
        "drizzle-kit": "^0.30.0",
        tsx: "^4.19.0",
        typescript: "^5.7.0",
      },
    },
    null,
    2,
  ) + "\n";

const TSCONFIG =
  JSON.stringify(
    {
      compilerOptions: {
        target: "ESNext",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        outDir: "dist",
      },
      include: ["src"],
    },
    null,
    2,
  ) + "\n";

const DRIZZLE_CONFIG = withMarker(`import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DB_FILE_NAME ?? "./data.db" },
});
`);

const CLIENT = withMarker(`import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export const db = drizzle(new Database(process.env.DB_FILE_NAME ?? "./data.db"), { schema });
`);

const INDEX = withMarker(`import { app } from "./server";

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(\`listening on \${port}\`));
`);

const ENV = `DB_FILE_NAME=./data.db\nPORT=3000\n`;

const emitServer = (doc: IrDocument): string => {
  const cts = doc.contentTypes;
  const imports = cts
    .map(
      (ct) =>
        `import { ${expressNames(ct).table}Router } from "./routes/${expressNames(ct).table}";`,
    )
    .join("\n");
  const mounts = cts
    .map((ct) => `app.use("/api/${expressNames(ct).routeBase}", ${expressNames(ct).table}Router);`)
    .join("\n");
  return withMarker(`import express from "express";
${imports}

export const app = express();
app.use(express.json());
${mounts}
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});
`);
};

export const skeletonFiles = (doc: IrDocument, projectName: string): GeneratedFile[] => [
  { path: "package.json", content: PACKAGE_JSON(projectName) },
  { path: "tsconfig.json", content: TSCONFIG },
  { path: "drizzle.config.ts", content: DRIZZLE_CONFIG },
  { path: "src/db/client.ts", content: CLIENT },
  { path: "src/server.ts", content: emitServer(doc) },
  { path: "src/index.ts", content: INDEX },
  { path: ".env", content: ENV, mode: "seed" },
];
