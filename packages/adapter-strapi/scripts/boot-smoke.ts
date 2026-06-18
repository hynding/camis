// Generates, materializes, installs, boots Strapi on sqlite, asserts the Article
// route is registered (200 or 403 — both prove it's exposed; 404/500 fail).
// Runs in the gated CI job (Node 20). Cannot run in the restricted dev sandbox (npm denied).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
      if (res.status === 404 || res.status >= 500) return false; // not registered / boot error
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
};

const dir = await mkdtemp(join(tmpdir(), "camis-boot-"));
try {
  await materialize(
    strapiAdapter.generate({ document: blog, roles: [] }, { projectName: "blog" }),
    dir,
  );
  // Strapi hook contract coverage note: the `blog` fixture has no hooks (it is golden-tested
  // and must not be modified). End-to-end hook runtime coverage — including the reference impl
  // firing on publish — is provided by the Filament gated boot job. The Strapi hook contract
  // (generated contract file + seed stub + invocation wiring) is covered by the Strapi hooks
  // golden tests and the regen-preservation tests in the adapter-strapi package.
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: dir,
    stdio: "inherit",
  });
  if (install.status !== 0) {
    console.error(`npm install failed with exit code ${install.status}`);
    process.exit(1);
  }
  const proc: ChildProcess = spawn("npm", ["run", "develop"], {
    cwd: dir,
    stdio: "inherit",
    env: { ...process.env, BROWSER: "none" },
  });
  const ok = await pollUntilRegistered("http://127.0.0.1:1337/api/articles", 180_000);
  proc.kill("SIGTERM");
  await once(proc, "close"); // let Strapi release its working dir before cleanup
  if (!ok) {
    console.error("Article route not registered");
    process.exit(1);
  }
  console.log("BOOT SMOKE PASS: Article route registered");
} finally {
  await rm(dir, { recursive: true, force: true });
}
