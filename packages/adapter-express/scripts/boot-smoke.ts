// Generates, materializes, installs, pushes the schema, boots the SECURED API, logs in, and proves
// permission enforcement on denied paths: anonymous mutate → 403, a role's record condition hides a
// row → 404, and a read field rule strips a field for one role but not another.
// Runs ONLY in the gated CI job (needs npm + a running server + the target DB). Not run in the dev
// sandbox. The dialect is the first CLI arg (default sqlite); the DB connection comes from the
// environment (DB_FILE_NAME for sqlite, DATABASE_URL for mysql/pgsql).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import type { Dialect } from "../src/dialect";
import { expressAdapterFor } from "../src/generate";
import { secured } from "../src/__fixtures__/secured";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Poll the API until it responds (or time out). A secured route answers 403 without a token — still
// "up" (status < 500), so the poll succeeds and the assertions below drive the real checks.
const waitForServer = async (url: string, timeoutMs: number): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
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

const root = "http://127.0.0.1:3210/api";
const authBase = "http://127.0.0.1:3210/auth";
const bearer = (token: string) => ({ ...headers, authorization: `Bearer ${token}` });
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const login = async (email: string): Promise<string> => {
  const res = await fetch(`${authBase}/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password: "dev" }),
  });
  if (res.status !== 200) fail(`login ${email} → ${res.status}`);
  return ((await res.json()) as { token: string }).token;
};

let proc: ChildProcess | undefined;
try {
  await materialize(expressAdapterFor(dialect).generate(secured, { projectName: "blog" }), dir);
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
  if (!(await waitForServer(`${root}/articles`, 30_000))) fail("server did not start within 30s");

  const editor = await login("editor@example.com");

  // allowed: Editor creates a published Article carrying a secret
  const created = await fetch(`${root}/articles`, {
    method: "POST",
    headers: bearer(editor),
    body: JSON.stringify({ title: "hello", status: "published", secret_notes: "classified" }),
  });
  if (created.status !== 201) fail(`editor create → ${created.status}`);
  const publishedId = ((await created.json()) as { id: number }).id;

  // denied: anonymous (no token) create → 403
  const anon = await fetch(`${root}/articles`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "nope" }),
  });
  if (anon.status !== 403) fail(`anonymous create expected 403, got ${anon.status}`);

  // record condition: a draft Article is invisible (404) to the Viewer (condition status==published)
  const draft = await fetch(`${root}/articles`, {
    method: "POST",
    headers: bearer(editor),
    body: JSON.stringify({ title: "secret", status: "draft" }),
  });
  const draftId = ((await draft.json()) as { id: number }).id;

  const viewer = await login("viewer@example.com");
  const viewerDraft = await fetch(`${root}/articles/${draftId}`, { headers: bearer(viewer) });
  if (viewerDraft.status !== 404) fail(`viewer should not see draft, got ${viewerDraft.status}`);

  // field rule: the Viewer sees the published Article but NOT its secret_notes (read rule denies);
  // the Editor (no read rule) sees it.
  const viewerPub = await fetch(`${root}/articles/${publishedId}`, { headers: bearer(viewer) });
  const viewerBody = (await viewerPub.json()) as { title?: string; secret_notes?: string };
  if (viewerPub.status !== 200 || viewerBody.title !== "hello")
    fail(`viewer published read failed: ${JSON.stringify(viewerBody)}`);
  if (viewerBody.secret_notes !== undefined)
    fail(`viewer should NOT see secret_notes, got ${viewerBody.secret_notes}`);

  const editorPub = await fetch(`${root}/articles/${publishedId}`, { headers: bearer(editor) });
  const editorBody = (await editorPub.json()) as { secret_notes?: string };
  if (editorBody.secret_notes !== "classified")
    fail(`editor should see secret_notes, got ${JSON.stringify(editorBody)}`);

  console.log(`EXPRESS SECURED BOOT SMOKE PASS (${dialect})`);
} finally {
  proc?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true });
}
