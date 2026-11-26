// A project of bounded strings (issue #126), its schema pushed on the given dialect: each column
// keeps a value at its field's bound in four-byte characters, which MySQL's varchar(255) refused
// past 255 characters, and a unique one at the 673 characters its index holds. The generated
// routers call better-sqlite3's synchronous API, so the API serves writes on SQLite only: there it
// boots the secured API and drives it over HTTP, which refuses one character more, counting
// characters as PHP's mb_strlen does rather than UTF-16 code units, checks what the caller may
// write (a row the record condition refuses is a 403, a field the field rules strip no 400), and
// stores a text column's default. On MySQL and PostgreSQL the values go through the project's own
// driver instead, in a database of its own next to DATABASE_URL's, so drizzle-kit's push meets no
// other project's tables (it would ask whether one was renamed); the push itself proves MySQL takes
// the schema, a defaulted text column included. CI's adapter-express-boot workflow runs it as a
// step of its own on every leg: `tsx scripts/length-smoke.ts <dialect>`.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { materialize } from "@camis/adapter-kernel";
import type { IrBundle } from "@camis/permissions";
import type { Dialect } from "../src/dialect";
import { expressAdapterFor } from "../src/generate";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const fail = (msg: string): never => {
  throw new Error(msg);
};

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

const DATABASE = "camis_lengths";

// Run with the generated project's own driver, from its directory, once it is installed.
const CREATE_DATABASE: Record<"mysql" | "pgsql", string> = {
  mysql: `import mysql from "mysql2/promise";
const connection = await mysql.createConnection(process.env.DATABASE_URL);
await connection.query("DROP DATABASE IF EXISTS ${DATABASE}");
await connection.query("CREATE DATABASE ${DATABASE} CHARACTER SET utf8mb4");
await connection.end();
`,
  pgsql: `import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL);
await sql.unsafe("DROP DATABASE IF EXISTS ${DATABASE}");
await sql.unsafe("CREATE DATABASE ${DATABASE}");
await sql.end();
`,
};

const VALUES = {
  status: "open",
  code: wide(40),
  headline: wide(1000),
  slug: wide(300),
  handle: distinct(673),
  summary: wide(1000),
};

// Writes VALUES (from the VALUES variable, as JSON) and prints the row read back, as JSON.
const ROUND_TRIP: Record<"mysql" | "pgsql", string> = {
  mysql: `import mysql from "mysql2/promise";
const values = JSON.parse(process.env.VALUES);
const columns = Object.keys(values);
const connection = await mysql.createConnection(process.env.DATABASE_URL);
await connection.query("SET NAMES utf8mb4");
const [made] = await connection.execute(\`INSERT INTO entries (\${columns.join(", ")}) VALUES (\${columns.map(() => "?").join(", ")})\`, Object.values(values));
const [rows] = await connection.execute(\`SELECT \${columns.join(", ")} FROM entries WHERE id = ?\`, [made.insertId]);
console.log(JSON.stringify(rows[0]));
await connection.end();
`,
  pgsql: `import postgres from "postgres";
const values = JSON.parse(process.env.VALUES);
const sql = postgres(process.env.DATABASE_URL);
const [row] = await sql\`INSERT INTO entries \${sql(values)} RETURNING \${sql(Object.keys(values))}\`;
console.log(JSON.stringify(row));
await sql.end();
`,
};

/** DATABASE_URL naming this smoke's own database in place of its path. */
const ownDatabase = (url: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${DATABASE}`;
  return parsed.toString();
};

export const lengthSmoke = async (dialect: Dialect, port = 3213): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "camis-express-lengths-"));
  const env = {
    ...process.env,
    PORT: String(port),
    ...(dialect === "sqlite" ? { DB_FILE_NAME: join(dir, "data.db") } : {}),
  };
  let proc: ChildProcess | undefined;
  try {
    await materialize(expressAdapterFor(dialect).generate(BOUNDED, { projectName: "docs" }), dir);
    if (
      spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit", env })
        .status !== 0
    )
      fail("npm install failed");
    if (dialect !== "sqlite") {
      await writeFile(join(dir, "create-database.mjs"), CREATE_DATABASE[dialect]);
      if (
        spawnSync("node", ["create-database.mjs"], { cwd: dir, stdio: "inherit", env }).status !== 0
      )
        fail("creating the lengths database failed");
      env.DATABASE_URL = ownDatabase(env.DATABASE_URL ?? "");
    }
    if (
      spawnSync("npm", ["run", "db:push", "--", "--force"], { cwd: dir, stdio: "inherit", env })
        .status !== 0
    )
      fail("npm run db:push failed");
    if (dialect !== "sqlite") {
      await writeFile(join(dir, "round-trip.mjs"), ROUND_TRIP[dialect]);
      const run = spawnSync("node", ["round-trip.mjs"], {
        cwd: dir,
        env: { ...env, VALUES: JSON.stringify(VALUES) },
        encoding: "utf8",
      });
      if (run.status !== 0) fail(`the round trip failed: ${run.stderr}`);
      const row = JSON.parse(run.stdout) as Record<string, unknown>;
      for (const [field, value] of Object.entries(VALUES))
        if (row[field] !== value) fail(`${field} was not kept whole (${dialect})`);
      console.log(`LENGTHS OK (${dialect}, columns)`);
      return;
    }
    // A group of its own, so the server npm starts (through tsx) stops with it.
    proc = spawn("npm", ["start"], { cwd: dir, stdio: "inherit", env, detached: true });
    const base = `http://127.0.0.1:${port}`;
    const root = `${base}/api/entries`;
    let token = "";
    for (let i = 0; i < 60 && token === ""; i++) {
      try {
        const res = await fetch(`${base}/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "writer@example.com", password: "dev" }),
        });
        token = ((await res.json()) as { token: string }).token;
      } catch {
        await sleep(500);
      }
    }
    if (token === "") fail("the lengths server did not start");
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
    console.log(`LENGTHS OK (${dialect})`);
  } finally {
    try {
      if (proc?.pid !== undefined) process.kill(-proc.pid, "SIGTERM");
    } catch {
      // The group has exited already.
    }
    await rm(dir, { recursive: true, force: true });
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await lengthSmoke((process.argv[2] ?? "sqlite") as Dialect);
}
