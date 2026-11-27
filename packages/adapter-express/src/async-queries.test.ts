import type { ContentType } from "@camis/ir-schema";
import { describe, expect, it } from "vitest";
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

  it("serves only a numeric id, so no database is handed one it cannot compare", () => {
    expect(emitRoutes(article, [], { dialect: "pgsql" })).toContain(
      'articlesRouter.get("/:id(\\\\d+)", asyncRoute(async (req, res) => {',
    );
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
      '  const row = await find(id);\n  if (!row) {\n    res.status(404).json({ error: "not found" });\n    return;\n  }\n  res.status(201).json(row);',
    );
  });

  it("differ across databases only in how an insert answers its id", () => {
    for (const [, options] of variants) {
      const sqlite = emitRoutes(article, [], { ...options, dialect: "sqlite" });
      expect(emitRoutes(article, [], { ...options, dialect: "pgsql" })).toBe(sqlite);
      expect(emitRoutes(article, [], { ...options, dialect: "mysql" })).toBe(
        sqlite.replaceAll(".returning({ id: articles.id })", ".$returningId()"),
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

  it("keeps the transaction helper to projects with to-many links", () => {
    expect(content("sqlite", "src/db/atomic.ts", secured)).toBe("");
  });

  it("states MySQL's routes in a golden file of their own", async () => {
    await expect(content("mysql", "src/routes/notes.ts")).toMatchFileSnapshot(
      "./__golden__/morphs/notes.routes.mysql.ts.txt",
    );
  });
});
