import type { ChildProcess } from "node:child_process";
import { once } from "node:events";

// Stops a process spawned with `detached: true` together with everything it started.
export const stopProcessGroup = async (child: ChildProcess): Promise<void> => {
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
};
