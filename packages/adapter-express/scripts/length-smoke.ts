// A project of bounded strings (issue #126), its schema pushed on the given dialect: each column
// keeps a value at its field's bound in four-byte characters, which MySQL's varchar(255) refused
// past 255 characters. On SQLite it boots the API and drives it over HTTP, which also refuses one
// character more, counting characters as PHP's mb_strlen does rather than UTF-16 code units. The
// generated routers call better-sqlite3's synchronous API, so on MySQL and PostgreSQL the values go
// through the project's own driver instead, in a database of its own next to DATABASE_URL's, so
// drizzle-kit's push meets no other project's tables (it would ask whether one was renamed).
// boot-smoke.ts runs it on every leg; run alone with `tsx scripts/length-smoke.ts <dialect>`.
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
          { type: "string", name: "code", maxLength: 40 },
          { type: "string", name: "headline", maxLength: 1000 },
          { type: "string", name: "slug", unique: true, maxLength: 300 },
          { type: "text", name: "summary", maxLength: 1000 },
        ],
      },
    ],
    components: [],
  },
  roles: [],
};

const wide = (characters: number): string => "\u{1F600}".repeat(characters);

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

const VALUES = { code: wide(40), headline: wide(1000), slug: wide(300), summary: wide(1000) };

// Writes VALUES (from the VALUES variable, as JSON) and prints the row read back, as JSON.
const ROUND_TRIP: Record<"mysql" | "pgsql", string> = {
  mysql: `import mysql from "mysql2/promise";
const values = JSON.parse(process.env.VALUES);
const connection = await mysql.createConnection(process.env.DATABASE_URL);
await connection.query("SET NAMES utf8mb4");
const [made] = await connection.execute("INSERT INTO entries (code, headline, slug, summary) VALUES (?, ?, ?, ?)", [values.code, values.headline, values.slug, values.summary]);
const [rows] = await connection.execute("SELECT code, headline, slug, summary FROM entries WHERE id = ?", [made.insertId]);
console.log(JSON.stringify(rows[0]));
await connection.end();
`,
  pgsql: `import postgres from "postgres";
const values = JSON.parse(process.env.VALUES);
const sql = postgres(process.env.DATABASE_URL);
const [row] = await sql\`INSERT INTO entries (code, headline, slug, summary) VALUES (\${values.code}, \${values.headline}, \${values.slug}, \${values.summary}) RETURNING code, headline, slug, summary\`;
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
    proc = spawn("npm", ["start"], { cwd: dir, stdio: "inherit", env });
    const root = `http://127.0.0.1:${port}/api/entries`;
    const post = async (body: Record<string, unknown>) => {
      for (let i = 0; i < 60; i++) {
        try {
          const res = await fetch(root, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          return { status: res.status, body: (await res.json()) as Record<string, unknown> };
        } catch {
          await sleep(500);
        }
      }
      return fail("the lengths server did not start");
    };

    const made = await post(VALUES);
    if (made.status !== 201)
      fail(`create at the bounds → ${made.status} ${JSON.stringify(made.body)}`);
    const read = (await (await fetch(`${root}/${made.body.id as number}`)).json()) as Record<
      string,
      unknown
    >;
    for (const [field, value] of Object.entries(VALUES))
      if (read[field] !== value) fail(`${field} was not kept whole (${dialect})`);

    for (const [field, characters] of [
      ["code", 41],
      ["headline", 1001],
    ] as const) {
      const refused = await post({ [field]: wide(characters) });
      if (
        refused.status !== 400 ||
        refused.body.error !== `${field} must be at most ${characters - 1} characters`
      )
        fail(`${field} past its bound → ${refused.status} ${JSON.stringify(refused.body)}`);
    }
    console.log(`LENGTHS OK (${dialect})`);
  } finally {
    proc?.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await lengthSmoke((process.argv[2] ?? "sqlite") as Dialect);
}
