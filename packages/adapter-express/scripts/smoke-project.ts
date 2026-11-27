// What every Express smoke does around its HTTP checks: generate a project, install it, give it a
// database of its own, push its schema, start its server and stop it again. On MySQL and PostgreSQL
// the database is `<DATABASE_URL's database>_<name>`, next to DATABASE_URL's, so drizzle-kit's push
// meets no other project's tables (it would ask whether one was renamed).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import type { IrBundle } from "@camis/permissions";
import type { Dialect } from "../src/dialect";
import { expressAdapterFor } from "../src/generate";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const fail = (msg: string): never => {
  throw new Error(msg);
};

// Run with the generated project's own driver, from its directory, once it is installed, connected
// to DATABASE_URL's database.
const CREATE_DATABASE: Record<"mysql" | "pgsql", (database: string) => string> = {
  mysql: (database) => `import mysql from "mysql2/promise";
const connection = await mysql.createConnection(process.env.DATABASE_URL);
await connection.query("DROP DATABASE IF EXISTS ${database}");
await connection.query("CREATE DATABASE ${database} CHARACTER SET utf8mb4");
await connection.end();
`,
  pgsql: (database) => `import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
await sql.unsafe("DROP DATABASE IF EXISTS ${database}");
await sql.unsafe("CREATE DATABASE ${database}");
await sql.end();
`,
};

// FORCE: a connection the stopped server left open does not keep PostgreSQL from dropping it.
const DROP_DATABASE: Record<"mysql" | "pgsql", (database: string) => string> = {
  mysql: (database) => `import mysql from "mysql2/promise";
const connection = await mysql.createConnection(process.env.DATABASE_URL);
await connection.query("DROP DATABASE IF EXISTS ${database}");
await connection.end();
`,
  pgsql: (database) => `import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
await sql.unsafe("DROP DATABASE IF EXISTS ${database} WITH (FORCE)");
await sql.end();
`,
};

/** DATABASE_URL naming the project's own database in place of its own. */
const ownDatabase = (url: string, name: string): { url: string; database: string } => {
  const parsed = new URL(url);
  const database = `${parsed.pathname.slice(1) || "camis"}_${name}`;
  parsed.pathname = `/${database}`;
  return { url: parsed.toString(), database };
};

export interface SmokeProject {
  dir: string;
  env: NodeJS.ProcessEnv;
  /** Starts the server, in a process group of its own so that `stop` stops tsx under npm too. */
  start: () => void;
  /** Stops the server, if it runs, drops the project's database and removes the project. */
  stop: () => Promise<void>;
}

const run = (command: string, args: string[], dir: string, env: NodeJS.ProcessEnv): void => {
  if (spawnSync(command, args, { cwd: dir, stdio: "inherit", env }).status !== 0)
    fail(`${command} ${args.join(" ")} failed in ${dir}`);
};

/** A generated project, installed, its schema pushed to a database of its own, its server not started. */
export const smokeProject = async (
  bundle: IrBundle,
  dialect: Dialect,
  name: string,
  port: number,
): Promise<SmokeProject> => {
  const dir = await mkdtemp(join(tmpdir(), `camis-express-${name}-`));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    ...(dialect === "sqlite" ? { DB_FILE_NAME: join(dir, "data.db") } : {}),
  };
  const adminEnv = { ...env };
  let proc: ChildProcess | undefined;
  let exited: Promise<unknown> = Promise.resolve();
  let created: string | undefined;
  const stop = async () => {
    try {
      if (proc?.pid !== undefined) process.kill(-proc.pid, "SIGTERM");
    } catch {
      // The group has exited already.
    }
    await exited;
    try {
      if (created !== undefined && dialect !== "sqlite") {
        await writeFile(join(dir, "drop-database.mjs"), DROP_DATABASE[dialect](created));
        run("node", ["drop-database.mjs"], dir, adminEnv);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  try {
    await materialize(expressAdapterFor(dialect).generate(bundle, { projectName: name }), dir);
    run("npm", ["install", "--no-audit", "--no-fund"], dir, env);
    if (dialect !== "sqlite") {
      const own = ownDatabase(env.DATABASE_URL ?? fail("DATABASE_URL is not set"), name);
      await writeFile(join(dir, "create-database.mjs"), CREATE_DATABASE[dialect](own.database));
      created = own.database;
      run("node", ["create-database.mjs"], dir, env);
      env.DATABASE_URL = own.url;
    }
    run("npm", ["run", "db:push", "--", "--force"], dir, env);
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    dir,
    env,
    start: () => {
      const started = spawn("npm", ["start"], { cwd: dir, stdio: "inherit", env, detached: true });
      exited = new Promise((resolve) => started.once("exit", resolve));
      proc = started;
    },
    stop,
  };
};

/** Polls until the server answers below 500 (a secured route's 403 is up), or gives up. */
export const waitForServer = async (url: string, timeoutMs = 30_000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // Connection refused: not up yet.
    }
    await sleep(500);
  }
  fail(`the server at ${url} did not start within ${timeoutMs / 1000}s`);
};
