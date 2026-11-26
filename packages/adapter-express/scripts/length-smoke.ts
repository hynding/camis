// Boots a project of bounded strings (unsecured) on the given dialect and drives it over HTTP
// (issue #126): each column keeps a value at its field's bound in four-byte characters, which
// MySQL's varchar(255) would have refused past 255 characters, and the API refuses one character
// more, counting characters as PHP's mb_strlen does rather than UTF-16 code units. boot-smoke.ts
// runs it on every leg, last: on MySQL and PostgreSQL its schema push replaces the secured
// project's tables. Run alone with `tsx scripts/length-smoke.ts <dialect>`.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
    for (const args of [
      ["install", "--no-audit", "--no-fund"],
      ["run", "db:push", "--", "--force"],
    ]) {
      if (spawnSync("npm", args, { cwd: dir, stdio: "inherit", env }).status !== 0)
        fail(`npm ${args[0]} failed`);
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

    const values = {
      code: wide(40),
      headline: wide(1000),
      slug: wide(300),
      summary: wide(1000),
    };
    const made = await post(values);
    if (made.status !== 201)
      fail(`create at the bounds → ${made.status} ${JSON.stringify(made.body)}`);
    const read = (await (await fetch(`${root}/${made.body.id as number}`)).json()) as Record<
      string,
      unknown
    >;
    for (const [field, value] of Object.entries(values))
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
