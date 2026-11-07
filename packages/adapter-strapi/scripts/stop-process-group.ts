import type { ChildProcess } from "node:child_process";
import { once } from "node:events";

const GRACE_MS = 15_000;
const POLL_MS = 100;

const groupIsAlive = (groupId: number): boolean => {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForGroupToExit = async (groupId: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (groupIsAlive(groupId)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return true;
};

const signalGroup = (groupId: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-groupId, signal);
  } catch {
    /* the group already exited */
  }
};

// Stops a process spawned with `detached: true` (so it leads its own process group)
// together with everything it started, and resolves once all of them have exited.
// SIGTERM first so Strapi can close its database; SIGKILL whatever ignores it.
export const stopProcessGroup = async (child: ChildProcess): Promise<void> => {
  const groupId = child.pid;
  if (groupId === undefined) throw new Error("stopProcessGroup: the child never started");
  const childExited = child.exitCode !== null || child.signalCode !== null;
  const exited = childExited ? Promise.resolve() : once(child, "exit");
  signalGroup(groupId, "SIGTERM");
  if (!(await waitForGroupToExit(groupId, GRACE_MS))) {
    signalGroup(groupId, "SIGKILL");
    await waitForGroupToExit(groupId, GRACE_MS);
  }
  await exited;
};
