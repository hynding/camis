// Generates, materializes, installs, boots Strapi on sqlite, asserts the Article
// route is registered (200 or 403 — both prove it's exposed; 404/500 fail).
// Runs in the gated CI job (Node 20). Cannot run in the restricted dev sandbox (npm denied).
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import { strapiAdapter } from "../src/generate";
import { blog } from "../src/__fixtures__/blog";

const pollUntilRegistered = async (url: string, timeoutMs: number): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200 || res.status === 403) return true; // registered (403 = default-deny)
      if (res.status === 404) return false;
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
};

const dir = await mkdtemp(join(tmpdir(), "camis-boot-"));
try {
  await materialize(strapiAdapter.generate(blog, { projectName: "blog" }), dir);
  spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
  const proc = spawn("npm", ["run", "develop"], {
    cwd: dir,
    stdio: "inherit",
    env: { ...process.env, BROWSER: "none" },
  });
  const ok = await pollUntilRegistered("http://127.0.0.1:1337/api/articles", 180_000);
  proc.kill("SIGTERM");
  if (!ok) {
    console.error("Article route not registered");
    process.exit(1);
  }
  console.log("BOOT SMOKE PASS: Article route registered");
} finally {
  await rm(dir, { recursive: true, force: true });
}
