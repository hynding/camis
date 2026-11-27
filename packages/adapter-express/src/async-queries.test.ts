import { readFile } from "node:fs/promises";
import type { ContentType } from "@camis/ir-schema";
import { describe, expect, it } from "vitest";
import { blog } from "./__fixtures__/blog";
import { morphs } from "./__fixtures__/morphs";
import { secured } from "./__fixtures__/secured";
import type { Dialect } from "./dialect";
import { expressAdapterFor } from "./generate";
import { emitRoutes, type RouteOptions } from "./routes";

// The PostgreSQL (postgres-js) and MySQL (mysql2) clients answer every query with a promise and
// have none of better-sqlite3's synchronous calls, so the generated API awaits each query, which
// better-sqlite3's client answers too, and one project serves its routes on every database.
const DIALECTS: Dialect[] = ["sqlite", "pgsql", "mysql"];
const SYNCHRONOUS_CALL = /\.(all|get|run|values)\(\)|\.returning\(\)\.get\(\)/;

const article = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "string", name: "title", maxLength: 40 },
    { type: "boolean", name: "published" },
    { type: "text", name: "summary" },
  ],
} as ContentType;

const variants: [string, RouteOptions][] = [
  ["unsecured", {}],
  ["secured", { secured: true }],
  ["unsecured, with an AI field", { aiColumns: ["summary"] }],
  ["unsecured, owning links", { links: "own" }],
  ["secured, owning links", { secured: true, links: "own" }],
  ["secured, reading inverses", { secured: true, links: "inverse" }],
];

describe("the generated routers on every database", () => {
  for (const dialect of DIALECTS) {
    for (const [name, options] of variants) {
      const ts = emitRoutes(article, ["author_id"], { ...options, dialect });
      it(`call none of better-sqlite3's synchronous API (${name}, ${dialect})`, () => {
        expect(ts).not.toMatch(SYNCHRONOUS_CALL);
        expect(ts).not.toContain(".returning()");
      });
      it(`hand Express 4 every async route through asyncRoute (${name}, ${dialect})`, () => {
        expect(ts).toContain('import { asyncRoute } from "../async-route";');
        const routes = ts.match(/articlesRouter\.(get|post|patch|delete)\(/g) ?? [];
        const wrapped = ts.match(/articlesRouter\.\w+\("[^"]+", asyncRoute\(async \(/g) ?? [];
        expect(routes.length).toBe(5);
        expect(wrapped.length).toBe(5);
      });
    }
  }

  it("reads one row as the first of at most one", () => {
    const ts = emitRoutes(article, [], { dialect: "pgsql" });
    expect(ts).toContain(
      "const find = async (id: number) =>\n  (await db.select().from(articles).where(eq(articles.id, id)).limit(1))[0];",
    );
  });

  it("lists rows in id order, which no database guarantees without one", () => {
    expect(emitRoutes(article, [], { dialect: "pgsql" })).toContain(
      "await db.select().from(articles).orderBy(asc(articles.id))",
    );
    expect(emitRoutes(article, [], { secured: true, dialect: "pgsql" })).toContain(
      "await db.select().from(articles).orderBy(asc(articles.id))",
    );
  });

  it("serves only an id every database can compare, a 32-bit one, answering 404 for any other", () => {
    for (const [, options] of variants) {
      const ts = emitRoutes(article, [], { ...options, dialect: "pgsql" });
      expect(ts).toContain('import { routeId } from "../ids";');
      expect(ts).toContain(
        'export const articlesRouter = Router();\narticlesRouter.param("id", routeId);',
      );
      expect(ts).toContain('articlesRouter.get("/:id", asyncRoute(async (req, res) => {');
    }
  });

  it("takes an insert's id from RETURNING, or from MySQL's insert id, and reads the row back", () => {
    for (const dialect of ["sqlite", "pgsql"] as const)
      expect(emitRoutes(article, [], { dialect })).toContain(
        "const [{ id }] = await db.insert(articles).values(data).returning({ id: articles.id });",
      );
    expect(emitRoutes(article, [], { dialect: "mysql" })).toContain(
      "const [{ id }] = await db.insert(articles).values(data).$returningId();",
    );
    expect(emitRoutes(article, [], { dialect: "pgsql" })).toContain(
      "  const row = await find(id);\n  if (!row) throw new Error(`articles ${id} was written but could not be read back`);\n  res.status(201).json(row);",
    );
  });

  it("differ across databases only in how an insert answers its id and in the row lock", () => {
    const locked = (ts: string) =>
      ts.replace(
        "(await tx.select().from(articles).where(eq(articles.id, id)).limit(1))[0];",
        '(await tx.select().from(articles).where(eq(articles.id, id)).limit(1).for("update"))[0];',
      );
    for (const [name, options] of variants) {
      const sqlite = emitRoutes(article, [], { ...options, dialect: "sqlite" });
      const lockedOrNot = options.secured === true ? locked : (ts: string) => ts;
      expect(emitRoutes(article, [], { ...options, dialect: "pgsql" }), name).toBe(
        lockedOrNot(sqlite),
      );
      expect(emitRoutes(article, [], { ...options, dialect: "mysql" }), name).toBe(
        lockedOrNot(sqlite).replaceAll(".returning({ id: articles.id })", ".$returningId()"),
      );
    }
  });

  it("update, then read the row back, as no MySQL update returns it", () => {
    const ts = emitRoutes(article, [], { dialect: "mysql" });
    expect(ts).toContain(
      "    await db.update(articles).set(data).where(eq(articles.id, id));\n  const row = await find(id);",
    );
  });

  it("answer an unsecured update with nothing to write with the row unchanged, as the secured one does", () => {
    const ts = emitRoutes(article, [], { dialect: "sqlite" });
    expect(ts).toContain(
      "  if (Object.keys(data).length > 0)\n    await db.update(articles).set(data).where(eq(articles.id, id));",
    );
  });

  it("answer a create whose row cannot be read back with a 500, on every router", () => {
    for (const [name, options] of variants)
      expect(emitRoutes(article, [], { ...options, dialect: "mysql" }), name).toContain(
        "if (!row) throw new Error(`articles ${id} was written but could not be read back`);",
      );
  });

  describe("a secured update or delete", () => {
    const lock = {
      sqlite: "(await tx.select().from(articles).where(eq(articles.id, id)).limit(1))[0];",
      pgsql:
        '(await tx.select().from(articles).where(eq(articles.id, id)).limit(1).for("update"))[0];',
      mysql:
        '(await tx.select().from(articles).where(eq(articles.id, id)).limit(1).for("update"))[0];',
    };
    for (const dialect of DIALECTS) {
      it(`reads its row, checks it and writes it in one transaction, the row locked (${dialect})`, () => {
        const ts = emitRoutes(article, [], { secured: true, dialect });
        expect(ts).toContain(
          `const lockRow = async (tx: Executor, id: number) =>\n  ${lock[dialect]}`,
        );
        expect(ts).toContain(
          '  const outcome = await atomic(async (tx) => {\n    const existing = await lockRow(tx, id);\n    if (!existing) return { status: 404, error: "not found" };\n    const write = await permittedUpdate(tx, req, existing, incoming);\n    if ("error" in write) return write;\n    if (Object.keys(write.data).length > 0)\n      await tx.update(articles).set(write.data).where(eq(articles.id, id));',
        );
        expect(ts).toContain(
          '  const deleted = await atomic(async (tx) => {\n    const existing = await lockRow(tx, id);\n    if (!existing || !recordAllowed(req, "Article", "delete", existing)) return false;\n    await tx.delete(articles).where(eq(articles.id, id));\n    return true;\n  });',
        );
      });
    }
    it("checks the record condition, the field rules and the bounds of what it writes", () => {
      const ts = emitRoutes(article, [], { secured: true, dialect: "pgsql" });
      expect(ts).toContain(
        '  if (!recordAllowed(req, "Article", "update", existing)) return { status: 404, error: "not found" };\n  const permitted = stripWrites(req, "Article", { ...existing, ...incoming }, incoming);\n  const data = permitted;\n  if (!recordAllowed(req, "Article", "update", { ...existing, ...data })) return { status: 403, error: "forbidden" };\n  const longer = tooLong(data, MAX_LENGTHS);\n  if (longer !== null) return { status: 400, error: longer };',
      );
    });
    it("generates AI fields outside the transaction, writing them only if the locked row permits the same write", () => {
      const ts = emitRoutes(article, [], {
        secured: true,
        aiColumns: ["summary"],
        dialect: "pgsql",
      });
      const patch = ts.slice(ts.indexOf("articlesRouter.patch("));
      const populate = patch.indexOf(
        'await populateAiFields("Article", { ...before.data }, "update")',
      );
      expect(populate).toBeGreaterThan(0);
      expect(patch.indexOf("await atomic(")).toBeGreaterThan(populate);
      expect(patch).toContain(
        '    if (JSON.stringify(write.data) !== JSON.stringify(before.data))\n      return { status: 409, error: "the entry changed while it was being updated; send the update again" };',
      );
    });
  });

  it("write a row and its to-many links in one transaction", () => {
    const ts = emitRoutes(article, [], { links: "own", dialect: "pgsql" });
    expect(ts).toContain('import { atomic } from "../db/atomic";');
    expect(ts).toContain(
      '  const id = await atomic(async (tx) => {\n    const [{ id }] = await tx.insert(articles).values(data).returning({ id: articles.id });\n    await writeLinks(tx, "Article", id, body);\n    return id;\n  });',
    );
    expect(ts).toContain(
      '  await atomic(async (tx) => {\n    await dropLinks(tx, "Article", id);\n    await tx.delete(articles).where(eq(articles.id, id));\n  });',
    );
  });
});

/** The body of each `atomic(async (tx) => { … })` callback in emitted code. */
const atomicBodies = (ts: string): string[] =>
  [...ts.matchAll(/atomic\(async \(tx\) => \{\n([\s\S]*?)\n {2}\}\);/g)].map((m) => m[1] ?? "");

// A transaction holds a pooled connection on PostgreSQL and MySQL: a query inside it through the
// pool waits for a second one, and as many concurrent transactions as the pool holds wait forever.
describe("a transaction's queries", () => {
  for (const dialect of DIALECTS) {
    for (const [name, options] of variants) {
      it(`go through its tx, never the pool (${name}, ${dialect})`, () => {
        const ts = emitRoutes(article, ["author_id"], { ...options, dialect });
        for (const body of atomicBodies(ts)) {
          expect(body).not.toMatch(/\bdb\./);
          expect(body).not.toMatch(/\bfind\(/);
          expect(body).not.toMatch(
            /\b(checkLinks|permittedUpdate|readLinks)\(req|\b(checkLinks|readLinks)\("/,
          );
        }
      });
    }
    it(`are found in every router that writes in one (${dialect})`, () => {
      expect(
        atomicBodies(emitRoutes(article, [], { secured: true, links: "own", dialect })),
      ).toHaveLength(3);
    });
  }

  it("pass the link checks their executor, the transaction's inside it", () => {
    const ts = emitRoutes(article, [], { secured: true, links: "own", dialect: "pgsql" });
    expect(ts).toContain("    const write = await permittedUpdate(tx, req, existing, incoming);");
    expect(ts).toContain(
      '  const refused = await checkLinks(executor, "Article", permitted, allowed(req));',
    );
    expect(ts).toContain(
      'const refused = await checkLinks(db, "Article", permitted, allowed(req));',
    );
    expect(ts).toContain(
      'filterRead(req, "Article", await readLinks(db, "Article", row, allowed(req)));',
    );
  });
});

describe("the generated project on every database", () => {
  const generate = (dialect: Dialect, bundle = morphs) =>
    expressAdapterFor(dialect).generate(bundle, { projectName: "notes" });
  const content = (dialect: Dialect, path: string, bundle = morphs) =>
    generate(dialect, bundle).files.find((f) => f.path === path)?.content ?? "";

  it("forwards an async route's error to Express's error handler", async () => {
    const wrapper = content("sqlite", "src/async-route.ts", secured);
    expect(wrapper).toContain("route(req, res).catch(next);");
    await expect(wrapper).toMatchFileSnapshot("./__golden__/async-route.ts.txt");
  });

  it("awaits every link query", async () => {
    for (const dialect of DIALECTS) {
      const morphsFile = content(dialect, "src/morphs.ts");
      expect(morphsFile, dialect).not.toMatch(SYNCHRONOUS_CALL);
      expect(morphsFile, dialect).toBe(content("sqlite", "src/morphs.ts"));
    }
  });

  for (const dialect of DIALECTS) {
    it(`runs a transaction its client can hold (${dialect})`, async () => {
      await expect(content(dialect, "src/db/atomic.ts")).toMatchFileSnapshot(
        `./__golden__/atomic/atomic.${dialect}.ts.txt`,
      );
    });
    it(`regenerates identically (${dialect})`, () => {
      expect(generate(dialect)).toEqual(generate(dialect));
      expect(generate(dialect, secured)).toEqual(generate(dialect, secured));
    });
  }

  it("keeps the transaction helper to secured projects and projects with to-many links", () => {
    expect(content("sqlite", "src/db/atomic.ts", secured)).not.toBe("");
    expect(content("sqlite", "src/db/atomic.ts", blog)).toBe("");
  });

  it("answers an error any route hands on as JSON, from the last middleware", async () => {
    for (const bundle of [secured, blog]) {
      const server = content("pgsql", "src/server.ts", bundle);
      expect(server).toContain('import { errorHandler } from "./error-handler";');
      expect(server.trimEnd().endsWith("app.use(errorHandler);")).toBe(true);
    }
    await expect(content("pgsql", "src/error-handler.ts", blog)).toMatchFileSnapshot(
      "./__golden__/error-handler.ts.txt",
    );
    await expect(content("pgsql", "src/ids.ts", blog)).toMatchFileSnapshot(
      "./__golden__/ids.ts.txt",
    );
  });

  it("query links only through the executor they are given", () => {
    const morphsFile = content("pgsql", "src/morphs.ts");
    expect(morphsFile).not.toContain('import { db } from "./db/client";');
    expect(morphsFile).not.toMatch(/\bdb\./);
    expect(morphsFile).toContain(
      "export const checkLinks = async (\n  executor: Executor,\n  type: string,",
    );
    expect(morphsFile).toContain(
      "  Book: async (executor, id) =>\n    (await executor.select().from(books)",
    );
  });

  it("run MySQL's transactions at READ COMMITTED, where InnoDB takes no gap locks", () => {
    expect(content("mysql", "src/db/atomic.ts")).toContain('{ isolationLevel: "read committed" }');
    expect(content("pgsql", "src/db/atomic.ts")).not.toContain("isolationLevel");
  });

  it("retries a transaction a database gave up on, a bounded number of times", () => {
    expect(content("mysql", "src/db/atomic.ts")).toContain("const RETRIED = new Set([1213]);");
    expect(content("pgsql", "src/db/atomic.ts")).toContain(
      'const RETRIED = new Set(["40001", "40P01"]);',
    );
    for (const dialect of ["mysql", "pgsql"] as const)
      expect(content(dialect, "src/db/atomic.ts")).toContain("const ATTEMPTS = 3;");
  });

  it("installs the better-sqlite3 major its runtime test runs", async () => {
    const own = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const generated = JSON.parse(content("sqlite", "package.json", blog)) as {
      dependencies: Record<string, string>;
    };
    const major = (range: string | undefined) => /\d+/.exec(range ?? "")?.[0];
    expect(major(generated.dependencies["better-sqlite3"])).toBe(
      major(own.devDependencies["better-sqlite3"]),
    );
  });

  it("refuses a link to an id no database row can have", () => {
    expect(content("pgsql", "src/morphs.ts")).toContain("  if (!isId(link.id)) return false;");
  });

  it("states MySQL's routes in a golden file of their own", async () => {
    await expect(content("mysql", "src/routes/notes.ts")).toMatchFileSnapshot(
      "./__golden__/morphs/notes.routes.mysql.ts.txt",
    );
  });
});
