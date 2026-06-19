import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { DIALECTS, type Dialect, type DialectSpec } from "./dialect";
import { expressNames } from "./names";

const PACKAGE_JSON = (projectName: string, spec: DialectSpec, secured: boolean): string =>
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
      dependencies: {
        ...spec.driverDep,
        "drizzle-orm": "^0.38.0",
        express: "^4.21.0",
        ...(secured ? { jsonwebtoken: "^9.0.0" } : {}),
      },
      devDependencies: {
        ...spec.devDriverDep,
        "@types/express": "^4.17.0",
        ...(secured ? { "@types/jsonwebtoken": "^9.0.0" } : {}),
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

const DRIZZLE_CONFIG = (spec: DialectSpec): string =>
  withMarker(`import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "${spec.configDialect}",
  ${spec.configCredentials},
});
`);

const CLIENT = (spec: DialectSpec): string =>
  withMarker(`${spec.clientImports}
import * as schema from "./schema";

export const db = ${spec.clientDb};
`);

const INDEX = withMarker(`import { app } from "./server";

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(\`listening on \${port}\`));
`);

const ENV = (spec: DialectSpec): string =>
  spec.dialect === "sqlite" ? `DB_FILE_NAME=./data.db\nPORT=3000\n` : `DATABASE_URL=\nPORT=3000\n`;

const emitServer = (doc: IrDocument, secured: boolean): string => {
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
  const authImports = secured
    ? `\nimport { verify } from "./auth/verify";\nimport { authRouter } from "./auth/login";`
    : "";
  const authWiring = secured ? `app.use(verify);\napp.use("/auth", authRouter);\n` : "";
  return withMarker(`import express from "express";
${imports}${authImports}

export const app = express();
app.use(express.json());
${authWiring}${mounts}
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});
`);
};

export const skeletonFiles = (
  doc: IrDocument,
  projectName: string,
  dialect: Dialect,
  options: { secured?: boolean } = {},
): GeneratedFile[] => {
  const spec = DIALECTS[dialect];
  const secured = options.secured ?? false;
  return [
    { path: "package.json", content: PACKAGE_JSON(projectName, spec, secured) },
    { path: "tsconfig.json", content: TSCONFIG },
    { path: "drizzle.config.ts", content: DRIZZLE_CONFIG(spec) },
    { path: "src/db/client.ts", content: CLIENT(spec) },
    { path: "src/server.ts", content: emitServer(doc, secured) },
    { path: "src/index.ts", content: INDEX },
    { path: ".env", content: ENV(spec), mode: "seed" },
  ];
};
