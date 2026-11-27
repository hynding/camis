import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { blog } from "./__fixtures__/blog";
import { secured } from "./__fixtures__/secured";
import { expressAdapterFor } from "./generate";

// The generated project's helpers, loaded and run: the transaction on better-sqlite3, the id guard
// and the JSON error handler. They are written next to this package, whose drizzle-orm and
// better-sqlite3 they import, and removed afterwards.
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

const generatedFile = (
  bundle: typeof blog,
  path: string,
  dialect: "sqlite" | "pgsql" | "mysql" = "sqlite",
): string => {
  const file = expressAdapterFor(dialect)
    .generate(bundle, { projectName: "runtime" })
    .files.find((f) => f.path === path);
  if (file === undefined) throw new Error(`${path} is not generated`);
  return file.content;
};

interface Database {
  run: (query: ReturnType<typeof sql>) => unknown;
  all: (query: ReturnType<typeof sql>) => unknown[];
}
interface AtomicModule {
  atomic: <T>(work: (tx: Database) => Promise<T>) => Promise<T>;
}
interface FakeResponse {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  status: (code: number) => FakeResponse;
  json: (body: unknown) => FakeResponse;
}
type Handler = (...args: unknown[]) => void;

const response = (): FakeResponse => {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    status: (code) => {
      res.statusCode = code;
      return res;
    },
    json: (body) => {
      res.body = body;
      res.headersSent = true;
      return res;
    },
  };
  return res;
};

let dir = "";
let atomic: AtomicModule["atomic"];
let db: Database;
let routeId: Handler;
let errorHandler: Handler;

beforeAll(async () => {
  dir = await mkdtemp(join(PACKAGE, ".generated-"));
  await writeFile(
    join(dir, "client.ts"),
    `import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
export const db = drizzle(new Database(":memory:"));
`,
  );
  await writeFile(join(dir, "atomic.ts"), generatedFile(secured, "src/db/atomic.ts"));
  await writeFile(join(dir, "ids.ts"), generatedFile(blog, "src/ids.ts"));
  await writeFile(join(dir, "error-handler.ts"), generatedFile(blog, "src/error-handler.ts"));
  ({ atomic } = (await import(join(dir, "atomic.ts"))) as AtomicModule);
  ({ db } = (await import(join(dir, "client.ts"))) as { db: Database });
  ({ routeId } = (await import(join(dir, "ids.ts"))) as { routeId: Handler });
  ({ errorHandler } = (await import(join(dir, "error-handler.ts"))) as { errorHandler: Handler });
  db.run(sql`create table entries (v integer)`);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const values = (): unknown[] => db.all(sql`select v from entries order by v`);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the generated SQLite transaction", () => {
  it("makes a second transaction wait for the first rather than fail", async () => {
    db.run(sql`delete from entries`);
    const first = atomic(async (tx) => {
      tx.run(sql`insert into entries values (1)`);
      await pause(20);
      tx.run(sql`insert into entries values (2)`);
    });
    const second = atomic(async (tx) => {
      tx.run(sql`insert into entries values (3)`);
    });
    await Promise.all([first, second]);
    expect(values()).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }]);
  });

  it("refuses a transaction inside a transaction with a clear error, rolling the outer one back", async () => {
    db.run(sql`delete from entries`);
    await expect(
      atomic(async (tx) => {
        tx.run(sql`insert into entries values (1)`);
        await atomic(async () => undefined);
      }),
    ).rejects.toThrow("atomic() was called inside a transaction");
    expect(values()).toEqual([]);
  });

  it("rejects with the work's error when the rollback fails too", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      atomic(async (tx) => {
        tx.run(sql`commit`);
        throw new Error("the work failed");
      }),
    ).rejects.toThrow("the work failed");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    await expect(atomic(async () => "after")).resolves.toBe("after");
  });
});

interface PooledModule {
  atomic: <T>(work: (tx: string) => Promise<T>) => Promise<T>;
}
interface FakeClient {
  configs: unknown[];
  failures: unknown[];
}

// The pooled atomic against a client whose transaction fails with each of `failures` in turn.
const pooledAtomic = async (
  dialect: "pgsql" | "mysql",
): Promise<{ atomic: PooledModule["atomic"]; client: FakeClient }> => {
  const own = await mkdtemp(join(dir, `${dialect}-`));
  await writeFile(
    join(own, "client.ts"),
    `export const client = { configs: [] as unknown[], failures: [] as unknown[] };
export const db = {
  transaction: async <T>(work: (tx: string) => Promise<T>, config?: unknown): Promise<T> => {
    client.configs.push(config);
    const failure = client.failures.shift();
    if (failure !== undefined) throw failure;
    return work("tx");
  },
};
`,
  );
  await writeFile(join(own, "atomic.ts"), generatedFile(secured, "src/db/atomic.ts", dialect));
  const { atomic: pooled } = (await import(join(own, "atomic.ts"))) as PooledModule;
  const { client } = (await import(join(own, "client.ts"))) as { client: FakeClient };
  return { atomic: pooled, client };
};

describe("the generated PostgreSQL and MySQL transaction", () => {
  const deadlock = { pgsql: { code: "40P01" }, mysql: { errno: 1213, code: "ER_LOCK_DEADLOCK" } };
  for (const dialect of ["pgsql", "mysql"] as const) {
    it(`runs the work again when the database gave up on it, up to three times (${dialect})`, async () => {
      const { atomic: pooled, client } = await pooledAtomic(dialect);
      client.failures.push(deadlock[dialect], deadlock[dialect]);
      const started = Date.now();
      await expect(pooled(async (tx) => `done in ${tx}`)).resolves.toBe("done in tx");
      // A pause of at least 10ms before each attempt again, so that the transactions that
      // deadlocked do not meet again at once.
      expect(Date.now() - started).toBeGreaterThanOrEqual(20);
      expect(client.configs).toHaveLength(3);
      client.failures.push(deadlock[dialect], deadlock[dialect], deadlock[dialect]);
      await expect(pooled(async () => "never")).rejects.toBe(deadlock[dialect]);
    });
    it(`pauses a different 10 to 50ms before each attempt again (${dialect})`, async () => {
      const { atomic: pooled, client } = await pooledAtomic(dialect);
      const timers = vi.spyOn(globalThis, "setTimeout");
      const random = vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.999);
      client.failures.push(deadlock[dialect], deadlock[dialect]);
      await pooled(async () => undefined);
      expect(timers.mock.calls.map(([, delay]) => delay)).toEqual([10, 10 + 0.999 * 40]);
      random.mockRestore();
      timers.mockRestore();
    });
    it(`does not run the work again after any other failure (${dialect})`, async () => {
      const { atomic: pooled, client } = await pooledAtomic(dialect);
      const other = { code: "23505" };
      client.failures.push(other);
      await expect(pooled(async () => "never")).rejects.toBe(other);
      expect(client.configs).toHaveLength(1);
    });
  }
  it("asks MySQL for READ COMMITTED and PostgreSQL for its default", async () => {
    const mysql = await pooledAtomic("mysql");
    await mysql.atomic(async () => undefined);
    expect(mysql.client.configs).toEqual([{ isolationLevel: "read committed" }]);
    const pgsql = await pooledAtomic("pgsql");
    await pgsql.atomic(async () => undefined);
    expect(pgsql.client.configs).toEqual([undefined]);
  });
});

describe("the generated id guard", () => {
  for (const [id, served] of [
    ["1", true],
    ["2147483647", true],
    ["2147483648", false],
    ["99999999999", false],
    ["0", false],
    ["abc", false],
    ["1e3", false],
    ["0001", false],
    [`${"0".repeat(40)}1`, false],
    ["-1", false],
  ] as const) {
    it(`${served ? "serves" : "answers 404 for"} the id ${id}`, () => {
      const res = response();
      const next = vi.fn();
      routeId({}, res, next, id);
      expect(next).toHaveBeenCalledTimes(served ? 1 : 0);
      if (!served) {
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "not found" });
      }
    });
  }
});

describe("the generated error handler", () => {
  it("answers a failure 500 with nothing of it, logging it on the server", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = Object.assign(new Error('insert into "articles" failed: relation missing'), {
      query: 'insert into "articles" ("title") values ($1)',
    });
    const res = response();
    errorHandler(failure, {}, res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).toBe('{"error":"internal error"}');
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  // A driver's error carries the statement and its values (mysql2's `sql`, postgres-js's
  // `parameters` and `detail`), and its message can quote a value too.
  for (const [driver, failure] of [
    [
      "mysql2",
      Object.assign(new Error("Duplicate entry 'secret-value' for key 'entries.slug'"), {
        code: "ER_DUP_ENTRY",
        errno: 1062,
        sqlState: "23000",
        sqlMessage: "Duplicate entry 'secret-value' for key 'entries.slug'",
        sql: "insert into `entries` (`slug`) values ('secret-value')",
      }),
    ],
    [
      "postgres-js",
      Object.assign(new Error('invalid input syntax for type integer: "secret-value"'), {
        name: "PostgresError",
        code: "22P02",
        detail: "Key (slug)=(secret-value) already exists.",
        query: 'insert into "entries" ("slug") values ($1)',
        parameters: ["secret-value"],
      }),
    ],
  ] as const) {
    it(`logs a ${driver} error's name, code and stack frames, never a value it carries`, () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      errorHandler(failure, {}, response(), vi.fn());
      const line = logged.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
      logged.mockRestore();
      expect(line).not.toContain("secret-value");
      expect(line).toContain(failure.code);
      expect(line).toContain("generated-runtime.test.ts");
    });
  }

  it("logs any other error's name, message and stack", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    errorHandler(
      new TypeError("articles 7 was written but could not be read back"),
      {},
      response(),
      vi.fn(),
    );
    const line = logged.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    logged.mockRestore();
    expect(line).toContain("TypeError");
    expect(line).toContain("articles 7 was written but could not be read back");
    expect(line).toContain("generated-runtime.test.ts");
  });

  it("answers a client error, such as a body that does not parse, with its message as JSON", () => {
    const res = response();
    const parse = Object.assign(new SyntaxError("Unexpected token } in JSON at position 9"), {
      status: 400,
      expose: true,
    });
    errorHandler(parse, {}, res, vi.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Unexpected token } in JSON at position 9" });
  });

  it("leaves an error after the answer began to Express", () => {
    const res = response();
    res.headersSent = true;
    const next = vi.fn();
    const failure = new Error("late");
    errorHandler(failure, {}, res, next);
    expect(next).toHaveBeenCalledWith(failure);
  });
});
