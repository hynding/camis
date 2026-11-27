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

const generatedFile = (bundle: typeof blog, path: string): string => {
  const file = expressAdapterFor("sqlite")
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

describe("the generated id guard", () => {
  for (const [id, served] of [
    ["1", true],
    ["2147483647", true],
    ["2147483648", false],
    ["99999999999", false],
    ["0", false],
    ["abc", false],
    ["1e3", false],
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
    expect(logged).toHaveBeenCalledWith(failure);
    logged.mockRestore();
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
