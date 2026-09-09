// Cross-backend executable oracle for the Strapi storage layout (Phase 17).
//
// Generates a Strapi project and the storage-layout Laravel app from the same IR fixture, boots
// each in turn against ONE SQLite file, and asserts that rows and JWTs written by one are read
// correctly by the other. Not a unit test: it needs npm, composer and PHP, so it runs only in the
// gated `strapi-storage-crosscheck` workflow (and by hand via `pnpm --filter @camis/cli crosscheck`).
//
// Every secret below is a placeholder for a throwaway temp-directory instance; nothing here ever
// touches a real .env.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filamentAdapter } from "@camis/adapter-filament";
import { materialize } from "@camis/adapter-kernel";
import { strapiAdapter } from "@camis/adapter-strapi";
// The fixture both adapters are golden-tested against. A script may reach across packages for it;
// shipping code may not.
import { storageBundle } from "../../adapter-filament/src/strapi-api/storage/__fixtures__/storage";
import type { Io } from "../src/io";
import { scaffoldCommand } from "../src/commands/scaffold";

const STRAPI_PORT = 1447;
const PHP_PORT = 8765;
const STRAPI_URL = `http://127.0.0.1:${STRAPI_PORT}`;
const PHP_URL = `http://127.0.0.1:${PHP_PORT}`;
// Placeholder, never a real secret — but at least 32 bytes: firebase/php-jwt refuses a shorter
// HMAC key, while Strapi signs happily with any length, so a short shared secret would fail the
// PHP side alone with an undifferentiated 401.
const JWT_SECRET = "crosscheck-shared-hs256-placeholder";
const PASSWORD = "crosscheck-password";
const STRAPI_BOOT_TIMEOUT_MS = 600_000;
const PHP_BOOT_TIMEOUT_MS = 60_000;

class CrosscheckError extends Error {
  constructor(
    message: string,
    readonly expected?: string,
    readonly actual?: string,
  ) {
    super(message);
    this.name = "CrosscheckError";
  }
}

const step = (line: string): void => {
  process.stdout.write(`\n=== ${line}\n`);
};
const note = (line: string): void => {
  process.stdout.write(`  · ${line}\n`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── child processes ───────────────────────────────────────────────────────────────────────────
// `npm run develop` and `php artisan serve` both fork a worker, so signalling the process group
// is the only way to be sure the port is released; a stray Strapi would poison the next boot.
const running = new Set<ChildProcess>();

const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
};

const killAll = (): void => {
  for (const child of running) signalGroup(child, "SIGKILL");
  running.clear();
};
process.on("exit", killAll);
// Without this, Ctrl-C (or a CI job cancellation) leaves Strapi and `php artisan serve` running in
// their own detached process groups, orphaned and still holding ports 1447/8765 for the next run.
// `killAll` is idempotent (it clears `running` after signalling), so both handlers firing in any
// order — or the `finally` block's own stop() calls having already run — is harmless.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    killAll();
    process.exit(130);
  });
}

const start = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess => {
  const child = spawn(cmd, args, { cwd, env, stdio: "inherit", detached: true });
  running.add(child);
  return child;
};

const stop = async (child: ChildProcess): Promise<void> => {
  running.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalGroup(child, "SIGTERM");
  const closed = once(child, "close");
  const hard = setTimeout(() => signalGroup(child, "SIGKILL"), 20_000);
  await closed;
  clearTimeout(hard);
};

const exec = (cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): void => {
  note(`${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: env ?? process.env,
  });
  if (res.status !== 0) {
    throw new CrosscheckError(`${cmd} ${args.join(" ")} exited ${res.status ?? "on a signal"}`);
  }
};

// ── http ──────────────────────────────────────────────────────────────────────────────────────
interface Res {
  status: number;
  body: unknown;
  text: string;
}

const request = async (
  base: string,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Res> => {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token !== undefined) headers["Authorization"] = `Bearer ${options.token}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
};

const expectStatus = (res: Res, status: number, what: string): Res => {
  if (res.status !== status) {
    throw new CrosscheckError(
      `${what}: expected HTTP ${status}, got ${res.status}`,
      String(status),
      `${res.status} ${res.text.slice(0, 2000)}`,
    );
  }
  return res;
};

const envelope = (res: Res, what: string): unknown => {
  if (typeof res.body !== "object" || res.body === null || !("data" in res.body)) {
    throw new CrosscheckError(`${what}: response has no "data" envelope`, "{ data: … }", res.text);
  }
  return (res.body as { data: unknown }).data;
};

const waitForHealth = async (
  url: string,
  child: ChildProcess,
  timeoutMs: number,
  label: string,
): Promise<void> => {
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new CrosscheckError(
        `${label} exited (${child.exitCode ?? child.signalCode}) before it was healthy`,
      );
    }
    try {
      const res = await fetch(url);
      if (res.status === 204) {
        note(`${label} healthy after ${Math.round((Date.now() - began) / 1000)}s`);
        return;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(2000);
  }
  throw new CrosscheckError(`${label} was not healthy within ${timeoutMs / 1000}s (${url})`);
};

// ── comparison ────────────────────────────────────────────────────────────────────────────────
// Row identity and Strapi's own bookkeeping differ between the two backends by construction; the
// *content* must not. Component rows carry their own `id`, so the same key list covers them.
const IGNORED_KEYS = new Set([
  "id",
  "documentId",
  "createdAt",
  "updatedAt",
  "publishedAt",
  "locale",
]);

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (IGNORED_KEYS.has(key)) continue;
      out[key] = canonical(source[key]);
    }
    return out;
  }
  return value;
};

const show = (value: unknown): string => JSON.stringify(canonical(value), null, 2);

const assertSame = (what: string, expected: unknown, actual: unknown): void => {
  const e = show(expected);
  const a = show(actual);
  if (e !== a) throw new CrosscheckError(`${what}: wire shapes differ`, e, a);
  note(`${what} matches`);
};

const assertEqual = (what: string, expected: unknown, actual: unknown): void => {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new CrosscheckError(`${what}`, JSON.stringify(expected), JSON.stringify(actual));
  }
  note(`${what} ✓`);
};

// ── payloads ──────────────────────────────────────────────────────────────────────────────────
// Every optional field is filled: a null on one side and an absent key on the other is a real
// difference, and this check must not have to paper over one.
const notePayload = (
  recordId: string,
  text: string,
  occurredAt: string,
): Record<string, unknown> => ({
  recordId,
  text,
  occurredAt,
});

const rowPayloads = (userId: number): Record<string, Record<string, unknown>> => ({
  notes: { ...notePayload("n1", "written by strapi", "2026-09-08T10:00:00.000Z"), owner: userId },
  transactions: {
    recordId: "t1",
    amount: { minor: 1250, currency: "USD" },
    fee: 1.25,
    occurredOn: "2026-09-08",
    owner: userId,
  },
  "activity-sessions": {
    recordId: "s1",
    quantities: [
      { amount: 5.5, unit: "km" },
      { amount: 30.25, unit: "min" },
    ],
    owner: userId,
  },
  consumables: {
    recordId: "c1",
    facts: {
      calories: 250,
      servingSize: { amount: 1.5 },
      additional: [
        { slug: "protein", amount: 12.5 },
        { slug: "fat", amount: 3.25 },
      ],
    },
    creator: userId,
  },
});

// Components need explicit populate; relations deliberately do not — the Strapi-style wire shape
// carries a row's own scalars and components only, so populating `owner` would add a key the PHP
// serializer never emits.
const READ_QUERY: Record<string, string> = {
  notes: "",
  transactions: "?populate[amount]=true",
  "activity-sessions": "?populate[quantities]=true",
  consumables: "?populate[facts][populate]=*",
};

const main = async (): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "camis-crosscheck-"));
  const dbPath = join(root, "shared.db");
  const strapiDir = join(root, "strapi");
  const phpDir = join(root, "php");
  let strapi: ChildProcess | undefined;
  let php: ChildProcess | undefined;
  let ok = false;

  const strapiEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    BROWSER: "none",
    DATABASE_CLIENT: "sqlite",
    DATABASE_FILENAME: dbPath,
    APP_KEYS: "k1aaaaaaaaaaaaaaaaaaaa==,k2aaaaaaaaaaaaaaaaaaaa==",
    JWT_SECRET,
    ADMIN_JWT_SECRET: JWT_SECRET,
    API_TOKEN_SALT: JWT_SECRET,
    TRANSFER_TOKEN_SALT: JWT_SECRET,
    ENCRYPTION_KEY: "crosscheck-crosscheck-crosscheck-",
    HOST: "127.0.0.1",
    PORT: String(STRAPI_PORT),
  };

  const bootStrapi = async (label: string): Promise<ChildProcess> => {
    const child = start("npm", ["run", "develop"], strapiDir, strapiEnv);
    await waitForHealth(`${STRAPI_URL}/_health`, child, STRAPI_BOOT_TIMEOUT_MS, label);
    return child;
  };

  try {
    step(`workspace: ${root}`);

    // ── Strapi phase ──────────────────────────────────────────────────────────────────────────
    step("generating the Strapi project");
    await materialize(
      strapiAdapter.generate(storageBundle, { projectName: "crosscheck" }),
      strapiDir,
    );
    exec("npm", ["install", "--no-audit", "--no-fund"], strapiDir);

    step("booting Strapi on the shared database");
    strapi = await bootStrapi("strapi");

    step("registering alice through Strapi");
    const registered = expectStatus(
      await request(STRAPI_URL, "POST", "/api/auth/local/register", {
        body: { username: "alice", email: "alice@example.com", password: PASSWORD },
      }),
      200,
      "strapi register",
    );
    const session = registered.body as { jwt?: string; user?: { id?: number; username?: string } };
    const strapiJwt = session.jwt;
    const userId = session.user?.id;
    if (typeof strapiJwt !== "string" || typeof userId !== "number") {
      throw new CrosscheckError(
        "strapi register returned no { jwt, user.id }",
        "{ jwt, user }",
        registered.text,
      );
    }
    assertEqual("registered username", "alice", session.user?.username);

    step("creating one row of each shape through Strapi");
    const payloads = rowPayloads(userId);
    const strapiRows: Record<string, unknown> = {};
    for (const [plural, payload] of Object.entries(payloads)) {
      const created = expectStatus(
        await request(STRAPI_URL, "POST", `/api/${plural}`, {
          token: strapiJwt,
          body: { data: payload },
        }),
        201,
        `strapi create ${plural}`,
      );
      const documentId = (envelope(created, `strapi create ${plural}`) as { documentId?: string })
        .documentId;
      if (typeof documentId !== "string") {
        throw new CrosscheckError(
          `strapi create ${plural} returned no documentId`,
          "documentId",
          created.text,
        );
      }
      const read = expectStatus(
        await request(
          STRAPI_URL,
          "GET",
          `/api/${plural}/${documentId}${READ_QUERY[plural] ?? ""}`,
          {
            token: strapiJwt,
          },
        ),
        200,
        `strapi read ${plural}`,
      );
      strapiRows[plural] = envelope(read, `strapi read ${plural}`);
      note(`strapi ${plural}: ${show(strapiRows[plural])}`);
    }

    // The PHP side reads every row through an owner scope; if Strapi did not write the link row
    // the later 404 would look like a serializer fault, so prove the link exists here instead.
    const owned = expectStatus(
      await request(STRAPI_URL, "GET", "/api/notes?populate[owner]=true", { token: strapiJwt }),
      200,
      "strapi note owner",
    );
    const ownerId = (
      (envelope(owned, "strapi note owner") as { owner?: { id?: number } }[])[0]?.owner ?? {}
    ).id;
    assertEqual("note owner link written by strapi", userId, ownerId);

    await stop(strapi);
    strapi = undefined;
    note("strapi stopped");

    // ── PHP phase ─────────────────────────────────────────────────────────────────────────────
    step("scaffolding the Laravel host and overlaying the generated app");
    const io: Io = {
      readFile: (p) => readFile(p, "utf8"),
      writeFile: (p, c) => writeFile(p, c),
      materialize,
      copyDir: (s, d) => cp(s, d, { recursive: true, force: true }),
      exec: (cmd, args, cwd) =>
        new Promise((resolvePromise, rejectPromise) => {
          const child = spawn(cmd, args, { cwd, stdio: "inherit" });
          child.on("error", rejectPromise);
          child.on("close", (code) => resolvePromise(code ?? 1));
        }),
      out: (l) => process.stdout.write(`${l}\n`),
      cwd: root,
    };
    const scaffolded = await scaffoldCommand("filament", phpDir, io, { storage: "strapi" });
    if (scaffolded !== 0) throw new CrosscheckError(`camis scaffold exited ${scaffolded}`);

    await materialize(
      filamentAdapter.generate(storageBundle, {
        projectName: "crosscheck",
        apiStyle: "strapi",
        storageLayout: "strapi",
      }),
      phpDir,
    );

    await writeFile(
      join(phpDir, ".env"),
      [
        "APP_NAME=crosscheck",
        "APP_ENV=testing",
        "APP_KEY=",
        "APP_DEBUG=true",
        `APP_URL=${PHP_URL}`,
        "LOG_CHANNEL=stderr",
        "DB_CONNECTION=sqlite",
        `DB_DATABASE=${dbPath}`,
        `JWT_SECRET=${JWT_SECRET}`,
        "CAMIS_AUTH_THROTTLE_PER_MINUTE=1000",
        "CACHE_STORE=file",
        "SESSION_DRIVER=file",
        "",
      ].join("\n"),
    );
    exec("php", ["artisan", "key:generate", "--force"], phpDir);

    step("php artisan camis:strapi-schema-check");
    exec("php", ["artisan", "camis:strapi-schema-check"], phpDir);

    step("booting the PHP app on the same database file");
    // Deliberately not `{ ...process.env }`: Laravel's dotenv only fills in what a real
    // environment variable doesn't already override, so a stray DB_*/JWT_SECRET/APP_* in this
    // process's own environment could silently replace the .env this script just wrote. PATH is
    // needed to find `php` (and anything it shells out to), HOME because PHP/Composer-installed
    // tooling expects it, TMPDIR (when set) for the same reason PHP itself may consult it.
    const phpEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    };
    if (process.env.TMPDIR !== undefined) phpEnv.TMPDIR = process.env.TMPDIR;
    php = start(
      "php",
      ["artisan", "serve", "--host=127.0.0.1", `--port=${PHP_PORT}`],
      phpDir,
      phpEnv,
    );
    await waitForHealth(`${PHP_URL}/api/_health`, php, PHP_BOOT_TIMEOUT_MS, "php");

    step("the Strapi JWT authenticates against the PHP app");
    const me = expectStatus(
      await request(PHP_URL, "GET", "/api/users/me", { token: strapiJwt }),
      200,
      "php /api/users/me with the strapi jwt",
    );
    assertEqual("php /api/users/me username", "alice", (me.body as { username?: string }).username);

    step("every row Strapi wrote reads back identically from PHP");
    const keys: Record<string, string> = {
      notes: "n1",
      transactions: "t1",
      "activity-sessions": "s1",
      consumables: "c1",
    };
    const phpRows: Record<string, unknown> = {};
    for (const [plural, key] of Object.entries(keys)) {
      const read = expectStatus(
        await request(PHP_URL, "GET", `/api/${plural}/${key}`, { token: strapiJwt }),
        200,
        `php read ${plural}/${key}`,
      );
      phpRows[plural] = envelope(read, `php read ${plural}/${key}`);
      assertSame(`${plural}/${key}`, strapiRows[plural], phpRows[plural]);
    }

    // A deep-equal comparison alone cannot catch two backends independently dropping the same
    // key: {} matches {} even though the caller sent 1250. Pin the exact literal `rowPayloads`
    // sent for transactions/t1, in the biginteger wire form (a JSON string) both sides must use.
    assertEqual(
      "transactions/t1 amount.minor",
      "1250",
      (phpRows.transactions as { amount?: { minor?: unknown } }).amount?.minor,
    );

    step("PHP writes a second note and issues its own JWT");
    const putNote = expectStatus(
      await request(PHP_URL, "PUT", "/api/notes/n2", {
        token: strapiJwt,
        body: { data: notePayload("n2", "written by php", "2026-09-09T11:30:00.000Z") },
      }),
      200,
      "php PUT /api/notes/n2",
    );
    const phpNote = envelope(putNote, "php PUT /api/notes/n2");
    assertEqual("php note n2 recordId", "n2", (phpNote as { recordId?: string }).recordId);

    const login = expectStatus(
      await request(PHP_URL, "POST", "/api/auth/local", {
        body: { identifier: "alice", password: PASSWORD },
      }),
      200,
      "php POST /api/auth/local",
    );
    const phpJwt = (login.body as { jwt?: string }).jwt;
    if (typeof phpJwt !== "string") {
      throw new CrosscheckError("php login returned no jwt", "{ jwt }", login.text);
    }

    await stop(php);
    php = undefined;
    note("php stopped");

    // ── Strapi again, on the same file ────────────────────────────────────────────────────────
    step("re-booting Strapi on the same database file");
    strapi = await bootStrapi("strapi (second boot)");

    step("Strapi accepts the PHP JWT and lists both notes");
    const list = expectStatus(
      await request(STRAPI_URL, "GET", "/api/notes?sort=recordId", { token: phpJwt }),
      200,
      "strapi GET /api/notes with the php jwt",
    );
    const notes = envelope(list, "strapi GET /api/notes") as { recordId?: string }[];
    assertEqual(
      "strapi lists both notes",
      ["n1", "n2"],
      notes.map((n) => n.recordId),
    );
    assertSame("notes/n2 written by PHP, read by Strapi", phpNote, notes[1]);

    const strapiMe = expectStatus(
      await request(STRAPI_URL, "GET", "/api/users/me", { token: phpJwt }),
      200,
      "strapi GET /api/users/me with the php jwt",
    );
    assertEqual(
      "strapi /api/users/me username",
      "alice",
      (strapiMe.body as { username?: string }).username,
    );

    await stop(strapi);
    strapi = undefined;

    ok = true;
    process.stdout.write("\nCROSSCHECK OK\n");
  } finally {
    if (php !== undefined) await stop(php);
    if (strapi !== undefined) await stop(strapi);
    if (ok) {
      await rm(root, { recursive: true, force: true });
    } else {
      process.stdout.write(`\nworkspace kept for inspection: ${root}\n`);
    }
  }
};

try {
  await main();
} catch (error) {
  const e = error as CrosscheckError;
  process.stderr.write(`\nCROSSCHECK FAILED: ${e.message}\n`);
  if (e.expected !== undefined) {
    process.stderr.write(
      `\n--- expected (strapi)\n${e.expected}\n\n--- actual\n${e.actual ?? ""}\n`,
    );
  }
  process.exit(1);
}
