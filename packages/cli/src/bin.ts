import { spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import type { Io } from "./io";
import { run } from "./run";

const io: Io = {
  readFile: (p) => readFile(p, "utf8"),
  writeFile: async (p, c) => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, c);
  },
  materialize,
  copyDir: (s, d) => cp(s, d, { recursive: true, force: true }),
  exec: (cmd, args, cwd) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(cmd, args, { cwd, stdio: "inherit" });
      child.on("error", rejectPromise);
      child.on("close", (code) => resolvePromise(code ?? 1));
    }),
  out: (l) => process.stdout.write(`${l}\n`),
  cwd: process.cwd(),
};

run(process.argv.slice(2), io).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`camis: ${(err as Error).message}\n`);
    process.exit(1);
  },
);
