// Generates, materializes, installs, pushes the schema, boots the API, and round-trips a CRUD request.
// Runs ONLY in the gated CI job (needs npm + a running server). Not run in the dev sandbox.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import { expressAdapter } from "../src/generate";
import { blog } from "../src/__fixtures__/blog";

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

const dir = await mkdtemp(join(tmpdir(), "camis-express-"));
let proc: ChildProcess | undefined;
try {
  await materialize(expressAdapter.generate(blog, { projectName: "blog" }), dir);
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
  const base = "http://127.0.0.1:3210/api/articles";
  if (!(await waitForServer(base, 30_000))) {
    console.error("server did not start within 30s");
    process.exit(1);
  }
  const created = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "hello" }),
  });
  if (created.status !== 201) {
    console.error(`POST ${created.status}`);
    process.exit(1);
  }
  const { id } = (await created.json()) as { id: number };
  const got = await fetch(`${base}/${id}`);
  const body = (await got.json()) as { title?: string };
  if (got.status !== 200 || body.title !== "hello") {
    console.error("GET round-trip failed");
    process.exit(1);
  }
  const del = await fetch(`${base}/${id}`, { method: "DELETE" });
  if (del.status !== 204) {
    console.error(`DELETE ${del.status}`);
    process.exit(1);
  }
  console.log("EXPRESS BOOT SMOKE PASS");
} finally {
  proc?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true });
}
