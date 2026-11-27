import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import type { Dialect } from "./dialect";

// better-sqlite3 runs each statement synchronously, and drizzle's transaction over it takes no
// async work, so SQLite's transaction is opened and closed by hand.
const SQLITE = `import { sql } from "drizzle-orm";
import { db } from "./client";

/** What a transaction's work writes through: on SQLite, the one connection itself. */
export type Executor = typeof db;

/**
 * Runs the work in a transaction: committed when it settles, rolled back when it throws. The work
 * awaits nothing but this database, whose queries settle before any other request's callback runs,
 * so no other request's statement falls between BEGIN and COMMIT.
 */
export const atomic = async <T>(work: (tx: Executor) => Promise<T>): Promise<T> => {
  db.run(sql\`begin immediate\`);
  try {
    const result = await work(db);
    db.run(sql\`commit\`);
    return result;
  } catch (error) {
    db.run(sql\`rollback\`);
    throw error;
  }
};
`;

const POOLED = `import { db } from "./client";

/** What a transaction's work writes through: a connection of its own, held until it ends. */
export type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Runs the work in a transaction: committed when it settles, rolled back when it throws. */
export const atomic = <T>(work: (tx: Executor) => Promise<T>): Promise<T> => db.transaction(work);
`;

/** `src/db/atomic.ts`: the transaction a row and its to-many links are written in. */
export const atomicFile = (dialect: Dialect): GeneratedFile => ({
  path: "src/db/atomic.ts",
  content: withMarker(dialect === "sqlite" ? SQLITE : POOLED),
});
