// Generates the ownership fixture's Strapi project, boots it on sqlite and checks over HTTP that
// the generated controllers enforce the IR's row conditions, assigned owner and relation reach
// against a real Strapi 5 (the unit tests run them against a fake of its surface only).
// Runs in the gated CI job; cannot run in the restricted dev sandbox (npm denied).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import { strapiAdapter } from "../src/generate";
import { ownershipBundle } from "../src/__fixtures__/ownership";
import { stopProcessGroup } from "./stop-process-group";

const BASE = "http://127.0.0.1:1337";

interface Response {
  status: number;
  body: { data?: unknown; jwt?: string; user?: { id: number } } | null;
}

const call = async (
  method: string,
  path: string,
  jwt?: string,
  data?: unknown,
): Promise<Response> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(jwt === undefined ? {} : { authorization: `Bearer ${jwt}` }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : (JSON.parse(text) as Response["body"]) };
};

const failures: string[] = [];
const check = (what: string, ok: boolean, detail: unknown): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(`${what}: ${JSON.stringify(detail)}`);
};

const rows = (r: Response): { documentId: string; [key: string]: unknown }[] =>
  Array.isArray(r.body?.data) ? (r.body.data as { documentId: string }[]) : [];

const pollUntilUp = async (timeoutMs: number): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // The public role reads shared notes, so a booted project answers 200.
      const res = await fetch(`${BASE}/api/notes`);
      if (res.status === 200) return true;
      if (res.status === 404 || res.status >= 500) return false;
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
};

/** A registered account (which users-permissions puts in its default role), as a member. */
const member = async (dir: string, name: string) => {
  const registered = await call("POST", "/api/auth/local/register", undefined, {
    username: name,
    email: `${name}@example.test`,
    password: "Passw0rd!camis",
  });
  if (registered.status !== 200 || registered.body?.jwt === undefined)
    throw new Error(`register ${name}: ${JSON.stringify(registered)}`);
  // users-permissions has no API to change a user's role short of the admin panel, so move the
  // account in the database. The JWT names only the user; its role is loaded on every request.
  const require = createRequire(join(dir, "package.json"));
  const Database = require("better-sqlite3") as new (file: string) => {
    prepare(sql: string): { run(...args: unknown[]): { changes: number } };
    close(): void;
  };
  const db = new Database(join(dir, ".tmp", "data.db"));
  try {
    const moved = db
      .prepare(
        "UPDATE up_users_role_lnk SET role_id = (SELECT id FROM up_roles WHERE type = 'member') WHERE user_id = ?",
      )
      .run(registered.body.user!.id);
    if (moved.changes !== 1) throw new Error(`move ${name} to member: ${moved.changes} rows`);
  } finally {
    db.close();
  }
  return { jwt: registered.body.jwt, id: registered.body.user!.id };
};

const scenario = async (dir: string): Promise<void> => {
  const alice = await member(dir, "alice");
  const bob = await member(dir, "bob");

  // alice names bob as the owner; the server assigns alice instead.
  const created = await call("POST", "/api/notes", alice.jwt, {
    data: { title: "alice's", shared: false, owner: bob.id },
  });
  check("alice creates a note", created.status === 201, created);
  const aliceNote = (created.body?.data as { documentId?: string } | undefined)?.documentId ?? "";
  const aliceList = rows(await call("GET", "/api/notes", alice.jwt));
  check(
    "the client-supplied owner is overridden: alice lists her note",
    aliceList.some((n) => n.documentId === aliceNote),
    aliceList,
  );
  const bobList = rows(await call("GET", "/api/notes", bob.jwt));
  check(
    "bob does not list alice's note",
    !bobList.some((n) => n.documentId === aliceNote),
    bobList,
  );
  for (const [method, data] of [
    ["GET", undefined],
    ["PUT", { data: { title: "bob was here" } }],
    ["DELETE", undefined],
  ] as const) {
    const r = await call(method, `/api/notes/${aliceNote}`, bob.jwt, data);
    check(`bob's ${method} of alice's note is 404`, r.status === 404, r);
  }
  const still = await call("GET", `/api/notes/${aliceNote}`, alice.jwt);
  check(
    "alice's note is unchanged",
    (still.body?.data as { title?: string } | undefined)?.title === "alice's",
    still,
  );

  // The member role writes the owner relation only through assign, so it lacks user.find.
  const users = await call("GET", "/api/users", alice.jwt);
  check("the member role has no GET /api/users", users.status === 403, users.status);

  // A tag of bob's links bob's private note; neither alice nor a guest sees the note through it.
  const bobNote = await call("POST", "/api/notes", bob.jwt, {
    data: { title: "bob's", shared: false },
  });
  const bobNoteId = (bobNote.body?.data as { documentId?: string } | undefined)?.documentId;
  const tag = await call("POST", "/api/tags", bob.jwt, { data: { label: "b", note: bobNoteId } });
  check("bob tags his own note", tag.status === 201, tag);
  const tagId = (tag.body?.data as { documentId?: string } | undefined)?.documentId;
  // The tag itself must be listed, so a missing tag never passes for a hidden note.
  const listed = (r: Response) => rows(r).some((t) => t.documentId === tagId);
  const noteOf = (r: Response) => rows(r).find((t) => t.documentId === tagId)?.note;
  const asBob = await call("GET", "/api/tags?populate=note", bob.jwt);
  check("bob sees his note through his tag", noteOf(asBob) != null, asBob);
  for (const [who, jwt] of [
    ["alice", alice.jwt],
    ["a guest", undefined],
  ] as const) {
    for (const query of ["populate=note", "populate=*", "populate[note][fields][0]=title"]) {
      const r = await call("GET", `/api/tags?${query}`, jwt);
      check(
        `${who} sees no note through bob's tag (${query})`,
        r.status === 200 && listed(r) && noteOf(r) == null,
        r,
      );
    }
  }
  const oracle = await call("GET", "/api/tags?filters[note][title][$eq]=bob%27s", alice.jwt);
  check("alice's filter on bob's note matches nothing", rows(oracle).length === 0, oracle);
  const sort = await call("GET", "/api/tags?sort=note.title:asc", alice.jwt);
  check("alice's sort through the note is refused", sort.status === 400, sort.status);
  const link = await call("POST", "/api/tags", alice.jwt, {
    data: { label: "a", note: { connect: [{ documentId: bobNoteId }] } },
  });
  check("alice cannot connect bob's note", link.status === 403, link);
  // The refusal must stop the write, not only answer 403 after it.
  const after = rows(await call("GET", "/api/tags", bob.jwt));
  check("the refused connect created no tag", !after.some((t) => t.label === "a"), after);
};

const dir = await mkdtemp(join(tmpdir(), "camis-enforcement-"));
try {
  await materialize(strapiAdapter.generate(ownershipBundle, { projectName: "notes" }), dir);
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: dir,
    stdio: "inherit",
  });
  if (install.status !== 0) {
    console.error(`npm install failed with exit code ${install.status}`);
    process.exit(1);
  }
  // Its own process group, so teardown reaches Strapi's forked worker and Vite.
  const proc: ChildProcess = spawn("npm", ["run", "develop"], {
    cwd: dir,
    stdio: "inherit",
    detached: true,
    env: { ...process.env, BROWSER: "none" },
  });
  try {
    if (!(await pollUntilUp(180_000))) failures.push("Strapi did not answer GET /api/notes");
    else await scenario(dir);
  } catch (error) {
    failures.push(String(error));
  } finally {
    await stopProcessGroup(proc);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(`ENFORCEMENT SMOKE FAIL:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("ENFORCEMENT SMOKE PASS");
