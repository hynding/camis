// Generates, materializes, installs, then boots Strapi on sqlite once per project below, each on
// a fresh database, and asserts its route answers. The blog's Article (no roles) is registered:
// 200 or 403. The notes projects seed roles through the generated bootstrap: a grant without a
// condition, alone and beside a conditioned one; their public read must answer 200, which also
// proves the bootstrap ran to the end.
// Runs in the gated CI job (Node 22).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import type { IrBundle } from "@camis/permissions";
import { strapiAdapter } from "../src/generate";
import { blog } from "../src/__fixtures__/blog";
import { publicReadBundle, someConditionsBundle } from "../src/__fixtures__/note-grants";
import { stringSizes } from "../src/__fixtures__/string-sizes";
import { stopProcessGroup } from "./stop-process-group";

interface BootCase {
  name: string;
  bundle: IrBundle;
  route: string;
  accepted: number[];
}

// One project name for every case, so they share one package.json and one npm install.
const CASES: BootCase[] = [
  {
    name: "blog, no roles",
    bundle: { document: blog, roles: [] },
    route: "/api/articles",
    accepted: [200, 403], // 403 = default-deny: registered all the same
  },
  {
    name: "notes, a public grant without a condition",
    bundle: publicReadBundle,
    route: "/api/notes",
    accepted: [200],
  },
  {
    name: "notes, conditions on some grants only",
    bundle: someConditionsBundle,
    route: "/api/notes",
    accepted: [200],
  },
  {
    // Strapi takes the column settings a string bounded past 255 characters gets (issue #126).
    name: "entries, strings with column settings",
    bundle: { document: stringSizes, roles: [] },
    route: "/api/entries",
    accepted: [200, 403],
  },
];

const pollUntilAnswered = async (
  url: string,
  accepted: number[],
  proc: ChildProcess,
  timeoutMs: number,
): Promise<string | undefined> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) return `Strapi exited with code ${proc.exitCode}`;
    try {
      const res = await fetch(url);
      if (accepted.includes(res.status)) return undefined;
      if (res.status >= 400) return `${url} answered ${res.status}`;
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return `${url} did not answer within ${timeoutMs} ms`;
};

const boot = async (dir: string, bootCase: BootCase): Promise<string | undefined> => {
  await materialize(strapiAdapter.generate(bootCase.bundle, { projectName: "blog" }), dir);
  // A fresh database and build for every case.
  await rm(join(dir, ".tmp"), { recursive: true, force: true });
  await rm(join(dir, "dist"), { recursive: true, force: true });
  // Its own process group, so teardown reaches Strapi's forked worker and Vite: they
  // outlive a SIGTERM to npm and would keep writing node_modules while it is deleted.
  const proc: ChildProcess = spawn("npm", ["run", "develop"], {
    cwd: dir,
    stdio: "inherit",
    detached: true,
    env: { ...process.env, BROWSER: "none" },
  });
  try {
    return await pollUntilAnswered(
      `http://127.0.0.1:1337${bootCase.route}`,
      bootCase.accepted,
      proc,
      180_000,
    );
  } finally {
    await stopProcessGroup(proc);
  }
};

const dir = await mkdtemp(join(tmpdir(), "camis-boot-"));
try {
  await materialize(strapiAdapter.generate(CASES[0]!.bundle, { projectName: "blog" }), dir);
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
  for (const bootCase of CASES) {
    const failure = await boot(dir, bootCase);
    if (failure !== undefined) {
      console.error(`BOOT SMOKE FAIL (${bootCase.name}): ${failure}`);
      process.exit(1);
    }
    console.log(`BOOT SMOKE PASS (${bootCase.name}): ${bootCase.route} answered`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
