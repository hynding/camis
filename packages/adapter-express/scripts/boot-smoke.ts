// Generates, materializes, installs, pushes the schema, boots the API, and round-trips a CRUD
// request INCLUDING a relation FK (create an Author, then an Article referencing it).
// Runs ONLY in the gated CI job (needs npm + a running server + the target DB). Not run in the
// dev sandbox. The dialect is the first CLI arg (default sqlite); the matching DB connection comes
// from the environment (DB_FILE_NAME for sqlite, DATABASE_URL for mysql/pgsql).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import type { Dialect } from "../src/dialect";
import { expressAdapterFor } from "../src/generate";
import { catalog } from "../src/__fixtures__/catalog";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Poll the API until it responds (or time out), rather than a fixed sleep — more robust under CI load.
const waitForServer = async (url: string, timeoutMs: number): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true; // server is up and routing
    } catch {
      /* connection refused — not ready yet */
    }
    await sleep(500);
  }
  return false;
};

const dialect = (process.argv[2] ?? "sqlite") as Dialect;
const headers = { "content-type": "application/json" };
const dir = await mkdtemp(join(tmpdir(), "camis-express-"));
if (dialect === "sqlite") process.env.DB_FILE_NAME = join(dir, "data.db");

let proc: ChildProcess | undefined;
try {
  await materialize(expressAdapterFor(dialect).generate(catalog, { projectName: "blog" }), dir);
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: dir,
    stdio: "inherit",
  });
  if (install.status !== 0) process.exit(1);
  const push = spawnSync("npm", ["run", "db:push", "--", "--force"], {
    cwd: dir,
    stdio: "inherit",
  });
  if (push.status !== 0) process.exit(1);
  proc = spawn("npm", ["start"], {
    cwd: dir,
    stdio: "inherit",
    env: { ...process.env, PORT: "3210" },
  });
  const root = "http://127.0.0.1:3210/api";
  if (!(await waitForServer(`${root}/articles`, 30_000))) {
    console.error("server did not start within 30s");
    process.exit(1);
  }

  // 1. create an Author (the relation target)
  const authorRes = await fetch(`${root}/authors`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Ada" }),
  });
  if (authorRes.status !== 201) {
    console.error(`POST author ${authorRes.status}`);
    process.exit(1);
  }
  const { id: authorId } = (await authorRes.json()) as { id: number };

  // 2. create an Article referencing the Author via the FK column
  const articleRes = await fetch(`${root}/articles`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "hello", author_id: authorId }),
  });
  if (articleRes.status !== 201) {
    console.error(`POST article ${articleRes.status}`);
    process.exit(1);
  }
  const { id: articleId } = (await articleRes.json()) as { id: number };

  // 3. read it back and assert the relation FK persisted
  const got = await fetch(`${root}/articles/${articleId}`);
  const body = (await got.json()) as { title?: string; author_id?: number };
  if (got.status !== 200 || body.title !== "hello" || body.author_id !== authorId) {
    console.error(`GET round-trip failed: ${JSON.stringify(body)}`);
    process.exit(1);
  }

  const del = await fetch(`${root}/articles/${articleId}`, { method: "DELETE" });
  if (del.status !== 204) {
    console.error(`DELETE ${del.status}`);
    process.exit(1);
  }
  console.log(`EXPRESS BOOT SMOKE PASS (${dialect})`);
} finally {
  proc?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true });
}
