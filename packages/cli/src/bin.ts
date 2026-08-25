import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { materialize } from "@camis/adapter-kernel";
import type { Io } from "./io";
import { run } from "./run";

const io: Io = {
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, c) => writeFile(p, c),
  materialize,
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
