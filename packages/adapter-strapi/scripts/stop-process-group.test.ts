import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { stopProcessGroup } from "./stop-process-group";

// `npm run develop` → `strapi develop` → a forked worker running Vite: killing the npm
// process alone left the worker optimizing dependencies while the smoke deleted its
// node_modules, which failed the nightly job after it had passed.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const GRANDPARENT = `
const { spawn } = require("node:child_process");
const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(worker.pid);
setInterval(() => {}, 1000);
`;

describe("stopProcessGroup", () => {
  it("stops the processes the child started, not only the child", async () => {
    const child = spawn(process.execPath, ["-e", GRANDPARENT], {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    const [firstLine] = (await once(child.stdout!, "data")) as [Buffer];
    const workerPid = Number(firstLine.toString().trim());
    expect(isAlive(workerPid)).toBe(true);

    await stopProcessGroup(child);

    expect(isAlive(child.pid!)).toBe(false);
    expect(isAlive(workerPid)).toBe(false);
  });
});
