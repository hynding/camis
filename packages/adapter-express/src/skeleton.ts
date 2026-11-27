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

// Express 4 leaves a rejected promise unhandled: each async route hands its error to Express's
// error handler instead.
const ASYNC_ROUTE =
  withMarker(`import type { NextFunction, Request, RequestHandler, Response } from "express";

/** An async route whose error reaches Express's error handler (\`src/error-handler.ts\`). */
export const asyncRoute =
  (route: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    route(req, res).catch(next);
  };
`);

// PostgreSQL refuses to compare an integer column with NaN or with a number past its range, and
// MySQL's int holds no more either: such an id is no row's on any database.
const IDS = withMarker(`import type { NextFunction, Request, Response } from "express";

/** The largest id an integer id column holds on every database (PostgreSQL's and MySQL's int). */
export const MAX_ID = 2147483647;

/** Whether a value is an id a row may have: a whole number from 1 to MAX_ID. */
export const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_ID;

/** A route's \`:id\`: a decimal id a row may have, or the route answers 404 before any query. */
export const routeId = (_req: Request, res: Response, next: NextFunction, value: string): void => {
  if (/^\\d+$/.test(value) && isId(Number(value))) {
    next();
    return;
  }
  res.status(404).json({ error: "not found" });
};
`);

// Express's own error handler answers an HTML page with the error's stack, which can hold a failed
// query's text, outside production.
const ERROR_HANDLER = withMarker(`import type { NextFunction, Request, Response } from "express";

interface HttpError {
  status?: unknown;
  statusCode?: unknown;
  expose?: unknown;
  message?: unknown;
}

const clientStatus = (error: HttpError): number | undefined => {
  const status = error.status ?? error.statusCode;
  return typeof status === "number" && status >= 400 && status < 500 ? status : undefined;
};

/**
 * The last middleware, for an error a route or middleware hands on. A client error (express.json()'s
 * 400 for a body that does not parse, 413 for one too large) answers its message as JSON; any other
 * answers 500 with nothing of the error in it (no stack, query or path) and is logged on the server.
 */
export const errorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const details: HttpError = typeof error === "object" && error !== null ? error : {};
  const status = clientStatus(details);
  if (status !== undefined) {
    const exposed = details.expose === true && typeof details.message === "string";
    res.status(status).json({ error: exposed ? details.message : "bad request" });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "internal error" });
};
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
import { errorHandler } from "./error-handler";
${imports}${authImports}

export const app = express();
app.use(express.json());
${authWiring}${mounts}
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});
app.use(errorHandler);
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
    { path: "src/async-route.ts", content: ASYNC_ROUTE },
    { path: "src/error-handler.ts", content: ERROR_HANDLER },
    { path: "src/ids.ts", content: IDS },
    { path: ".env", content: ENV(spec), mode: "seed" },
  ];
};
