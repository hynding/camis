import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import type { Dialect } from "./dialect";

// better-sqlite3 runs each statement synchronously, and drizzle's transaction over it takes no
// async work, so SQLite's transaction is opened and closed by hand.
const SQLITE = `import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db } from "./client";

/** What a transaction's work writes through: on SQLite, the one connection itself. */
export type Executor = typeof db;

/** Set while a transaction's work runs, so that a transaction inside it is refused. */
const inTransaction = new AsyncLocalStorage<true>();
/** The transactions in the order they were asked for: each starts once the one before it ends. */
let queue: Promise<unknown> = Promise.resolve();

const transaction = async <T>(work: (tx: Executor) => Promise<T>): Promise<T> => {
  db.run(sql\`begin immediate\`);
  try {
    const result = await inTransaction.run(true, () => work(db));
    db.run(sql\`commit\`);
    return result;
  } catch (error) {
    try {
      db.run(sql\`rollback\`);
    } catch (rollbackError) {
      // The work's error is the one to answer; the rollback's would hide it.
      console.error("rollback failed:", rollbackError);
    }
    throw error;
  }
};

/**
 * Runs the work in a transaction: committed when it settles, rolled back when it throws. One
 * transaction runs at a time; another waits for it. The work awaits nothing but this database,
 * whose queries settle before any other request's callback runs, so no other request's statement
 * falls between BEGIN and COMMIT.
 */
export const atomic = <T>(work: (tx: Executor) => Promise<T>): Promise<T> => {
  if (inTransaction.getStore() === true)
    return Promise.reject(
      new Error("atomic() was called inside a transaction: SQLite holds one at a time; use its tx"),
    );
  const run = queue.then(() => transaction(work));
  queue = run.catch(() => undefined);
  return run;
};
`;

// On PostgreSQL and MySQL a transaction holds a pooled connection: every query its work makes goes
// through its tx, or as many concurrent transactions as the pool holds would each wait for a second
// connection forever.
const pooled = (dialect: "pgsql" | "mysql"): string => {
  const mysql = dialect === "mysql";
  return `import { db } from "./client";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** What a query goes through: the pool's \`db\`, or a transaction's own connection. */
export type Executor = Pick<Transaction, "select" | "insert" | "update" | "delete">;
${
  mysql
    ? `
// At REPEATABLE READ, InnoDB's gap locks deadlock link rows deleted by their owner and written again
// by concurrent transactions; READ COMMITTED takes none.
const CONFIG = { isolationLevel: "read committed" } as const;
`
    : ""
}
/** The failures on which the database rolled the transaction back so that it may run again. */
const RETRIED = new Set(${mysql ? "[1213]" : `["40001", "40P01"]`});
const ATTEMPTS = 3;
${
  mysql
    ? `// Not a lock wait timeout (1205): the work already waited innodb_lock_wait_timeout for its lock,
// and would wait as long again.
`
    : ""
}
/** A pause of 10 to 50ms, a different one for each, so that the transactions that met do not meet again at once. */
const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10 + Math.random() * 40));

const retried = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  RETRIED.has((error as { ${mysql ? "errno?: number" : "code?: string"} }).${mysql ? "errno" : "code"} ?? ${mysql ? "0" : `""`});

/**
 * Runs the work in a transaction: committed when it settles, rolled back when it throws. When the
 * database rolls it back to break ${mysql ? "a deadlock" : "a deadlock or a serialization conflict"},
 * the work runs again, up to ATTEMPTS times in all. So the work may run more than once: it does
 * nothing but query through its tx and return what it found, and sends no answer and changes nothing
 * outside the transaction.
 */
export const atomic = async <T>(work: (tx: Executor) => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(work${mysql ? ", CONFIG" : ""});
    } catch (error) {
      if (attempt >= ATTEMPTS || !retried(error)) throw error;
      await pause();
    }
  }
};
`;
};

/** `src/db/atomic.ts`: the transaction a row and its to-many links are written in. */
export const atomicFile = (dialect: Dialect): GeneratedFile => ({
  path: "src/db/atomic.ts",
  content: withMarker(dialect === "sqlite" ? SQLITE : pooled(dialect)),
});
