// A project of bounded strings (issue #126), its schema pushed on the given dialect: each column
// keeps a value at its field's bound in four-byte characters, which MySQL's varchar(255) refused
// past 255 characters, and a unique one at the 673 characters its index holds. It boots the secured
// API and drives it over HTTP on every dialect: it refuses one character more, counting characters
// as PHP's mb_strlen does rather than UTF-16 code units, checks what the caller may write (a row the
// record condition refuses is a 403, a field the field rules strip no 400), and stores a text
// column's default (on MySQL, Drizzle's, as a text column takes no literal default there). On MySQL
// and PostgreSQL the project has a database of its own next to DATABASE_URL's (smoke-project.ts).
// CI's adapter-express-boot workflow runs it as a step of its own on every leg:
// `pnpm --filter @camis/adapter-express smoke:lengths <dialect>`.
import { spawn, spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IrBundle } from "@camis/permissions";
import type { Dialect } from "../src/dialect";
import { fail, smokeProject, waitForServer, type SmokeProject } from "./smoke-project";

const BOUNDED: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Entry",
        kind: "collection",
        names: { plural: "Entries" },
        fields: [
          { type: "string", name: "status" },
          { type: "string", name: "code", maxLength: 40 },
          { type: "string", name: "headline", maxLength: 1000 },
          { type: "string", name: "slug", unique: true, maxLength: 300 },
          { type: "string", name: "handle", unique: true, maxLength: 1000 },
          { type: "text", name: "summary", maxLength: 1000 },
          { type: "string", name: "notes", maxLength: 10 },
          { type: "string", name: "tagline", maxLength: 500, default: "hello" },
        ],
      },
    ],
    components: [],
  },
  roles: [
    {
      name: "Writer",
      grants: [
        {
          contentType: "Entry",
          actions: ["create", "read", "update"],
          condition: {
            kind: "eq",
            left: { kind: "var", name: "record.status" },
            right: { kind: "lit", value: "open" },
          },
          // No user's id is 0: the Writer never writes notes.
          fieldRules: [
            {
              field: "notes",
              access: "write",
              when: {
                kind: "eq",
                left: { kind: "var", name: "user.id" },
                right: { kind: "lit", value: 0 },
              },
            },
          ],
        },
      ],
    },
  ],
};

const wide = (characters: number): string => "\u{1F600}".repeat(characters);

/** Four-byte characters that do not repeat (CJK Extension B), which PostgreSQL cannot compress. */
const distinct = (characters: number): string =>
  Array.from({ length: characters }, (_, i) => String.fromCodePoint(0x20000 + i)).join("");

const VALUES = {
  status: "open",
  code: wide(40),
  headline: wide(1000),
  slug: wide(300),
  handle: distinct(673),
  summary: wide(1000),
};

// Run with the project's own driver: holds the entry's row locked for 1.5s on a connection of its
// own, then closes it (status "closed", which the Writer's record condition refuses) and commits.
const CLOSE_LOCKED: Record<"mysql" | "pgsql", string> = {
  mysql: `import mysql from "mysql2/promise";
const id = Number(process.env.ID);
const connection = await mysql.createConnection(process.env.DATABASE_URL);
await connection.beginTransaction();
await connection.execute("SELECT id FROM entries WHERE id = ? FOR UPDATE", [id]);
console.log("locked");
await new Promise((r) => setTimeout(r, 1500));
await connection.execute("UPDATE entries SET status = 'closed' WHERE id = ?", [id]);
await connection.commit();
await connection.end();
`,
  pgsql: `import postgres from "postgres";
const id = Number(process.env.ID);
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
await sql.begin(async (tx) => {
  await tx\`SELECT id FROM entries WHERE id = \${id} FOR UPDATE\`;
  console.log("locked");
  await new Promise((r) => setTimeout(r, 1500));
  await tx\`UPDATE entries SET status = 'closed' WHERE id = \${id}\`;
});
await sql.end();
`,
};

// Prints the entry's code and status as JSON.
const READ_ENTRY: Record<"mysql" | "pgsql", string> = {
  mysql: `import mysql from "mysql2/promise";
const connection = await mysql.createConnection(process.env.DATABASE_URL);
const [rows] = await connection.execute("SELECT code, status FROM entries WHERE id = ?", [Number(process.env.ID)]);
console.log(JSON.stringify(rows[0]));
await connection.end();
`,
  pgsql: `import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
const [row] = await sql\`SELECT code, status FROM entries WHERE id = \${Number(process.env.ID)}\`;
console.log(JSON.stringify(row));
await sql.end();
`,
};

/**
 * A secured update racing a write that takes its row out of the caller's record condition: the
 * update reads the row locked, so it waits for the other write to commit and then refuses (404)
 * rather than writing a row the Writer may no longer update.
 */
const raceSmoke = async (
  dialect: "mysql" | "pgsql",
  project: SmokeProject,
  patch: (id: number, body: Record<string, unknown>) => Promise<{ status: number }>,
  id: number,
): Promise<void> => {
  const env = { ...project.env, ID: String(id) };
  await writeFile(join(project.dir, "close-locked.mjs"), CLOSE_LOCKED[dialect]);
  await writeFile(join(project.dir, "read-entry.mjs"), READ_ENTRY[dialect]);
  const closer = spawn("node", ["close-locked.mjs"], { cwd: project.dir, env });
  const closed = new Promise<number | null>((resolve) => closer.once("exit", resolve));
  await new Promise<void>((resolve, reject) => {
    closer.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("locked")) resolve();
    });
    closer.once("exit", () => reject(new Error("the locking connection ended before it locked")));
  });
  const started = Date.now();
  const raced = await patch(id, { code: "after" });
  const waited = Date.now() - started;
  if ((await closed) !== 0) fail("the locking connection failed");
  if (raced.status !== 404) fail(`an update racing a close → ${raced.status}, not 404`);
  if (waited < 1000) fail(`the update did not wait for the row lock (${waited}ms)`);
  const read = spawnSync("node", ["read-entry.mjs"], { cwd: project.dir, env, encoding: "utf8" });
  const row = JSON.parse(read.stdout) as { code: string; status: string };
  if (row.code !== "before" || row.status !== "closed")
    fail(`the raced row was written: ${JSON.stringify(row)}`);
  console.log(`ROW LOCK OK (${dialect})`);
};

const lengthSmoke = async (dialect: Dialect, port = 3213): Promise<void> => {
  const project = await smokeProject(BOUNDED, dialect, "lengths", port);
  try {
    project.start();
    const base = `http://127.0.0.1:${port}`;
    const root = `${base}/api/entries`;
    await waitForServer(root);
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "writer@example.com", password: "dev" }),
    });
    const { token } = (await login.json()) as { token: string };
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const send = async (method: "POST" | "PATCH", path: string, body: Record<string, unknown>) => {
      const res = await fetch(`${root}${path}`, { method, headers, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const read = async (id: unknown) =>
      (await (await fetch(`${root}/${id as number}`, { headers })).json()) as Record<
        string,
        unknown
      >;

    const made = await send("POST", "", VALUES);
    if (made.status !== 201)
      fail(`create at the bounds → ${made.status} ${JSON.stringify(made.body)}`);
    const kept = await read(made.body.id);
    for (const [field, value] of Object.entries(VALUES))
      if (kept[field] !== value) fail(`${field} was not kept whole (${dialect})`);
    if (kept.tagline !== "hello") fail(`tagline's default was not stored: ${String(kept.tagline)}`);

    for (const [field, characters] of [
      ["code", 41],
      ["headline", 1001],
    ] as const) {
      const message = `${field} must be at most ${characters - 1} characters`;
      const refused = await send("POST", "", { status: "open", [field]: wide(characters) });
      if (refused.status !== 400 || refused.body.error !== message)
        fail(`${field} past its bound → ${refused.status} ${JSON.stringify(refused.body)}`);
      const unchanged = await send("PATCH", `/${made.body.id as number}`, {
        [field]: wide(characters),
      });
      if (unchanged.status !== 400 || unchanged.body.error !== message)
        fail(`${field} past its bound on update → ${unchanged.status}`);
    }

    // What the caller may write is checked, not the body: the record condition refuses a row the
    // Writer could not have written before its length is, and a stripped field is never checked.
    const closed = await send("POST", "", { status: "closed", headline: wide(1001) });
    if (closed.status !== 403)
      fail(
        `a create the record condition refuses → ${closed.status} ${JSON.stringify(closed.body)}`,
      );
    const stripped = await send("POST", "", { status: "open", notes: wide(11) });
    if (stripped.status !== 201)
      fail(`a stripped field past its bound → ${stripped.status} ${JSON.stringify(stripped.body)}`);
    if ((await read(stripped.body.id)).notes !== null) fail("notes was written, not stripped");
    const strippedUpdate = await send("PATCH", `/${made.body.id as number}`, { notes: wide(11) });
    if (strippedUpdate.status !== 200)
      fail(`a stripped field past its bound on update → ${strippedUpdate.status}`);

    if (dialect !== "sqlite") {
      const racing = await send("POST", "", { status: "open", code: "before" });
      await raceSmoke(
        dialect,
        project,
        (id, body) => send("PATCH", `/${id}`, body),
        racing.body.id as number,
      );
    }
    console.log(`LENGTHS OK (${dialect})`);
  } finally {
    await project.stop();
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await lengthSmoke((process.argv[2] ?? "sqlite") as Dialect);
}
