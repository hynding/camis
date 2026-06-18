# Phase 8B — Express/Drizzle Breadth + Relations + Multi-Dialect + Round-Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `@camis/adapter-express` to the full IR field taxonomy, relations (Drizzle FK + `relations()`), three dialects (sqlite/mysql/pgsql via an `expressAdapterFor(dialect)` factory), and round-trip from a neutral `camis.schema.json`.

**Architecture:** A `dialect.ts` captures each dialect's Drizzle specifics; `column(dialect, field)` is the one breadth×dialect column map; `relations.ts` resolves FK columns + `relations()` blocks; `generate.ts` exposes `expressAdapterFor(dialect)` (default `expressAdapter = expressAdapterFor("sqlite")`) and emits `camis.schema.json`; `import.ts` reads it back. Golden the sqlite project; unit-test pg/mysql; a 3-DB gated boot is the integration oracle.

**Tech Stack:** TypeScript (strict, ESM), Vitest; emitted TS for Node 22 + Express 4 + drizzle-orm (sqlite-core/pg-core/mysql-core) + better-sqlite3/postgres/mysql2 + drizzle-kit.

**Design spec:** `docs/superpowers/specs/2026-06-18-phase-8b-express-breadth-design.md`

> **Invariants:** the dialect is bound at adapter CONSTRUCTION (factory), never via `GenerateOptions` (no target leak into the kernel). 8A's `Article` sqlite goldens MUST stay byte-identical (default dialect sqlite; relations only with relation fields) — verify without `-u`. String defaults stay escaped (8A security fix). `.ts` goldens use a `.ts.txt` extension.

---

## File structure (`packages/adapter-express/`)

- `src/dialect.ts` (new) — `Dialect`, `DialectSpec`, `DIALECTS`.
- `src/fields.ts` — `column(dialect, field)` (full taxonomy × dialect), `isSupportedField`.
- `src/relations.ts` (new) — `resolveRelations(doc, dialect)`.
- `src/schema.ts` — `emitSchema(ct, dialect, extras)`.
- `src/routes.ts` — include FK columns in the insertable pick-list.
- `src/skeleton.ts` — dialect-aware client/config/package.json.
- `src/import.ts` (new) — `importExpressProject(files)`.
- `src/generate.ts` — `expressAdapterFor(dialect)` + `expressAdapter`; emit `camis.schema.json`.
- fixtures, goldens, round-trip test; `scripts/boot-smoke.ts` + workflow matrix.

---

## Task 1: Dialect specs (`dialect.ts`)

**Files:** Create `packages/adapter-express/src/dialect.ts`, `packages/adapter-express/src/dialect.test.ts`.

- [ ] **Step 1: Failing test** `packages/adapter-express/src/dialect.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { DIALECTS } from "./dialect";

describe("DIALECTS", () => {
  it("sqlite spec", () => {
    expect(DIALECTS.sqlite.core).toBe("drizzle-orm/sqlite-core");
    expect(DIALECTS.sqlite.tableFn).toBe("sqliteTable");
    expect(DIALECTS.sqlite.configDialect).toBe("sqlite");
    expect(DIALECTS.sqlite.driverDep).toHaveProperty("better-sqlite3");
  });
  it("pgsql + mysql cores", () => {
    expect(DIALECTS.pgsql.core).toBe("drizzle-orm/pg-core");
    expect(DIALECTS.pgsql.tableFn).toBe("pgTable");
    expect(DIALECTS.mysql.core).toBe("drizzle-orm/mysql-core");
    expect(DIALECTS.mysql.tableFn).toBe("mysqlTable");
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/dialect.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-express/src/dialect.ts`
```ts
export type Dialect = "sqlite" | "mysql" | "pgsql";

export interface DialectSpec {
  dialect: Dialect;
  core: string; // drizzle-orm/<x>-core
  tableFn: string; // sqliteTable | pgTable | mysqlTable
  configDialect: string; // drizzle.config `dialect`
  idColumn: string; // the id primary-key column expression
  idImports: string[]; // imports the id column needs from `core`
  driverDep: Record<string, string>; // runtime driver dependency
  clientImports: string; // import lines for src/db/client.ts
  clientDb: string; // the `drizzle(...)` expression body
  configCredentials: string; // dbCredentials block for drizzle.config.ts
  timestamp: (col: string) => { expr: string; import: string }; // created_at/updated_at column
}

export const DIALECTS: Record<Dialect, DialectSpec> = {
  sqlite: {
    dialect: "sqlite",
    core: "drizzle-orm/sqlite-core",
    tableFn: "sqliteTable",
    configDialect: "sqlite",
    idColumn: `id: integer("id").primaryKey({ autoIncrement: true })`,
    idImports: ["integer"],
    driverDep: { "better-sqlite3": "^11.8.0" },
    clientImports: `import Database from "better-sqlite3";\nimport { drizzle } from "drizzle-orm/better-sqlite3";`,
    clientDb: `drizzle(new Database(process.env.DB_FILE_NAME ?? "./data.db"), { schema })`,
    configCredentials: `dbCredentials: { url: process.env.DB_FILE_NAME ?? "./data.db" }`,
    timestamp: (c) => ({ expr: `integer("${c}", { mode: "timestamp" })`, import: "integer" }),
  },
  pgsql: {
    dialect: "pgsql",
    core: "drizzle-orm/pg-core",
    tableFn: "pgTable",
    configDialect: "postgresql",
    idColumn: `id: serial("id").primaryKey()`,
    idImports: ["serial"],
    driverDep: { postgres: "^3.4.0" },
    clientImports: `import postgres from "postgres";\nimport { drizzle } from "drizzle-orm/postgres-js";`,
    clientDb: `drizzle(postgres(process.env.DATABASE_URL ?? ""), { schema })`,
    configCredentials: `dbCredentials: { url: process.env.DATABASE_URL ?? "" }`,
    timestamp: (c) => ({ expr: `timestamp("${c}")`, import: "timestamp" }),
  },
  mysql: {
    dialect: "mysql",
    core: "drizzle-orm/mysql-core",
    tableFn: "mysqlTable",
    configDialect: "mysql",
    idColumn: `id: int("id").primaryKey().autoincrement()`,
    idImports: ["int"],
    driverDep: { mysql2: "^3.11.0" },
    clientImports: `import mysql from "mysql2/promise";\nimport { drizzle } from "drizzle-orm/mysql2";`,
    clientDb: `drizzle(mysql.createPool(process.env.DATABASE_URL ?? ""), { schema, mode: "default" })`,
    configCredentials: `dbCredentials: { url: process.env.DATABASE_URL ?? "" }`,
    timestamp: (c) => ({ expr: `timestamp("${c}")`, import: "timestamp" }),
  },
};
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/dialect.test.ts`; typecheck.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/dialect.ts packages/adapter-express/src/dialect.test.ts
git commit -m "feat(adapter-express): per-dialect Drizzle specs (sqlite/pg/mysql)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Full taxonomy column map (`fields.ts` → `column(dialect, field)`)

Replaces `emitColumn(field)`/`isSupported8A` with `column(dialect, field)`/`isSupportedField`. One map keyed by `(dialect, fieldType)`. NOTE: the sqlite column expressions for the 8A types (string/text/email/uid/integer/float/boolean/dateTime) MUST be byte-identical to 8A so the `Article` golden is unchanged.

**Files:** Modify `packages/adapter-express/src/fields.ts`, `packages/adapter-express/src/fields.test.ts`.

- [ ] **Step 1: Replace `fields.ts`** with:
```ts
import type { Field } from "@camis/ir-schema";
import type { Dialect } from "./dialect";
import { snakeColumn } from "./names";

const SUPPORTED = new Set<string>([
  "string", "text", "richText", "email", "uid", "integer", "bigInteger", "float", "decimal",
  "boolean", "enumeration", "date", "time", "dateTime", "timestamp", "json", "media",
]);
export const isSupportedField = (t: string): boolean => SUPPORTED.has(t);

export interface ColumnEmit {
  column: string;
  drizzle: string;
  import: string; // the drizzle-core import the base column needs
}

const tsLiteral = (v: unknown): string =>
  typeof v === "boolean" ? (v ? "true" : "false")
  : typeof v === "number" ? String(v)
  : `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// Per-dialect base column (expression without modifiers) + the import it needs.
const base = (dialect: Dialect, field: Field, c: string): { expr: string; import: string } => {
  const text = { sqlite: `text('${c}')`, pgsql: `varchar('${c}', { length: 255 })`, mysql: `varchar('${c}', { length: 255 })` };
  const longtext = { sqlite: `text('${c}')`, pgsql: `text('${c}')`, mysql: `text('${c}')` };
  const imp = { sqlite: "text", pgsql: dialect === "pgsql" ? "varchar" : "text", mysql: "varchar" };
  switch (field.type) {
    case "string": case "email": case "uid":
      return { expr: text[dialect], import: dialect === "sqlite" ? "text" : "varchar" };
    case "text": case "richText": case "media":
      return { expr: longtext[dialect], import: "text" };
    case "enumeration":
      return { expr: longtext[dialect], import: "text" };
    case "integer":
      return dialect === "mysql" ? { expr: `int('${c}')`, import: "int" } : { expr: `integer('${c}')`, import: "integer" };
    case "bigInteger":
      return dialect === "sqlite" ? { expr: `integer('${c}')`, import: "integer" } : { expr: `bigint('${c}', { mode: 'number' })`, import: "bigint" };
    case "float":
      return dialect === "mysql" ? { expr: `float('${c}')`, import: "float" } : { expr: `real('${c}')`, import: "real" };
    case "decimal":
      return dialect === "mysql" ? { expr: `decimal('${c}')`, import: "decimal" } : { expr: `numeric('${c}')`, import: "numeric" };
    case "boolean":
      return dialect === "sqlite" ? { expr: `integer('${c}', { mode: 'boolean' })`, import: "integer" } : { expr: `boolean('${c}')`, import: "boolean" };
    case "json":
      return dialect === "sqlite" ? { expr: `text('${c}', { mode: 'json' })`, import: "text" } : dialect === "pgsql" ? { expr: `jsonb('${c}')`, import: "jsonb" } : { expr: `json('${c}')`, import: "json" };
    case "date":
      return dialect === "sqlite" ? { expr: `integer('${c}', { mode: 'timestamp' })`, import: "integer" } : { expr: `date('${c}')`, import: "date" };
    case "time":
      return dialect === "sqlite" ? { expr: `text('${c}')`, import: "text" } : { expr: `time('${c}')`, import: "time" };
    case "dateTime": case "timestamp":
      return dialect === "sqlite" ? { expr: `integer('${c}', { mode: 'timestamp' })`, import: "integer" } : { expr: `timestamp('${c}')`, import: "timestamp" };
    default:
      return { expr: dialect === "sqlite" ? `text('${c}')` : `varchar('${c}', { length: 255 })`, import: dialect === "sqlite" ? "text" : "varchar" };
  }
};

export const column = (dialect: Dialect, field: Field): ColumnEmit => {
  const f = field as Field & Record<string, unknown>;
  const c = snakeColumn(field.name);
  const b = base(dialect, field, c);
  const drizzle =
    b.expr +
    (f.required === true ? ".notNull()" : "") +
    (f.unique === true ? ".unique()" : "") +
    (f.default !== undefined ? `.default(${tsLiteral(f.default)})` : "");
  return { column: c, drizzle, import: b.import };
};
```
Note: `imp`/`text` helper objects above are illustrative — the `base` switch returns the correct `{ expr, import }` per dialect directly; remove any unused locals so ESLint is clean. The sqlite branches for the 8A types (`string→text('c')`, `boolean→integer('c', { mode: 'boolean' })`, `dateTime→integer('c', { mode: 'timestamp' })`, `integer→integer('c')`, `float→real('c')`, `text→text('c')`) reproduce the 8A output exactly.

- [ ] **Step 2: Rewrite `fields.test.ts`** — replace `emitColumn`/`isSupported8A` usages with `column(dialect, field)`/`isSupportedField`:
```ts
import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { column, isSupportedField } from "./fields";

describe("column (sqlite, 8A-compatible)", () => {
  it("required unique string", () => {
    expect(column("sqlite", { type: "string", name: "title", required: true, unique: true } as Field).drizzle).toBe("text('title').notNull().unique()");
  });
  it("boolean + dateTime modes", () => {
    expect(column("sqlite", { type: "boolean", name: "published" } as Field).drizzle).toBe("integer('published', { mode: 'boolean' })");
    expect(column("sqlite", { type: "dateTime", name: "publishedAt" } as Field).drizzle).toBe("integer('published_at', { mode: 'timestamp' })");
  });
  it("escapes string default", () => {
    expect(column("sqlite", { type: "string", name: "tag", default: "a'b\\c" } as Field).drizzle).toBe("text('tag').default('a\\'b\\\\c')");
  });
});

describe("column (pg / mysql breadth)", () => {
  it("pg string→varchar, boolean→boolean, json→jsonb", () => {
    expect(column("pgsql", { type: "string", name: "title" } as Field).drizzle).toBe("varchar('title', { length: 255 })");
    expect(column("pgsql", { type: "boolean", name: "ok" } as Field).drizzle).toBe("boolean('ok')");
    expect(column("pgsql", { type: "json", name: "meta" } as Field).import).toBe("jsonb");
  });
  it("mysql integer→int, float→float, decimal→decimal", () => {
    expect(column("mysql", { type: "integer", name: "n" } as Field).drizzle).toBe("int('n')");
    expect(column("mysql", { type: "decimal", name: "p" } as Field).import).toBe("decimal");
  });
  it("isSupportedField covers the full taxonomy, gaps relations/components", () => {
    expect(isSupportedField("json")).toBe(true);
    expect(isSupportedField("relation")).toBe(false);
    expect(isSupportedField("component")).toBe(false);
  });
});
```

- [ ] **Step 3: Update call sites** — `schema.ts` and `routes.ts` import `emitColumn`/`isSupported8A`; they are updated in Tasks 4/6. To keep THIS task green, also update `schema.ts` and `routes.ts` minimally NOW: change `isSupported8A` → `isSupportedField` and `emitColumn(f)` → `column("sqlite", f)` (a temporary literal that Tasks 4/6 replace with the threaded dialect). Update `generate.ts` `isSupported8A` → `isSupportedField` and its gap message (drop "Phase 8A"). Run `pnpm --filter @camis/adapter-express test` — the Article sqlite golden MUST be unchanged (the sqlite `column` output equals 8A's `emitColumn`); `git status --short src/__golden__/` empty.

- [ ] **Step 4: Run green + regression** — `pnpm --filter @camis/adapter-express test` (all pass; `__golden__/` git-status EMPTY), typecheck, lint.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src
git commit -m "feat(adapter-express): dialect-parameterized full-taxonomy column map

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Relations (`relations.ts`)

Resolves IR relations into dialect-typed Drizzle FK columns + `relations()` declaration blocks, with synthesized inverses (mirroring the Strapi/Filament adapters' dual rules).

**Files:** Create `packages/adapter-express/src/relations.ts`, `packages/adapter-express/src/relations.test.ts`.

- [ ] **Step 1: Failing test** `packages/adapter-express/src/relations.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { resolveRelations } from "./relations";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" }] },
    { name: "Author", kind: "collection", fields: [] },
  ],
  components: [],
};

describe("resolveRelations (express, sqlite)", () => {
  const r = resolveRelations(doc, "sqlite");
  it("owner gets an FK column referencing the target id", () => {
    expect(r.fkColumns.get("Article")!.some((c) => c.includes("author_id: integer('author_id').references(() => authors.id)"))).toBe(true);
  });
  it("emits relations() blocks for owner (one) and target (many)", () => {
    expect(r.relationBlocks.get("Article")!.some((b) => b.includes("one(authors"))).toBe(true);
    expect(r.relationBlocks.get("Author")!.some((b) => b.includes("many(articles"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/relations.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-express/src/relations.ts`
```ts
import type { ContentType, IrDocument, RelationKind } from "@camis/ir-schema";
import type { Dialect } from "./dialect";
import { expressNames, snakeColumn } from "./names";

export interface ResolvedRelations {
  fkColumns: Map<string, string[]>; // content type name → drizzle column lines for the FK
  relationBlocks: Map<string, string[]>; // content type name → relations() body lines
  needsRelationsImport: Set<string>; // content types that have a relations() block
}

const push = <V>(m: Map<string, V[]>, k: string, v: V): void => {
  const a = m.get(k) ?? [];
  a.push(v);
  m.set(k, a);
};

// FK column type matches the target's serial/integer id per dialect.
const fkType = (dialect: Dialect, col: string): string =>
  dialect === "mysql" ? `int('${col}')` : `integer('${col}')`;

export const resolveRelations = (doc: IrDocument, dialect: Dialect): ResolvedRelations => {
  const out: ResolvedRelations = { fkColumns: new Map(), relationBlocks: new Map(), needsRelationsImport: new Set() };
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const seenPivot = new Set<string>();

  for (const ct of doc.contentTypes) {
    for (const f of ct.fields) {
      if (f.type !== "relation") continue;
      const owner = ct.name;
      const target = f.target;
      const kind: RelationKind = f.relationKind;
      const ownerT = expressNames(byName.get(owner) as ContentType).table;
      const targetT = expressNames(byName.get(target) as ContentType).table;
      const inverse = (f as { inverse?: string }).inverse;

      if (kind === "manyToOne" || kind === "oneToOne") {
        const fk = `${snakeColumn(f.name)}_id`;
        const uniq = kind === "oneToOne" ? ".unique()" : "";
        push(out.fkColumns, owner, `  ${fk}: ${fkType(dialect, fk)}${uniq}.references(() => ${targetT}.id),`);
        push(out.relationBlocks, owner, `  ${f.name}: one(${targetT}, { fields: [${ownerT}.${fk}], references: [${targetT}.id] }),`);
        out.needsRelationsImport.add(owner);
        if (inverse) {
          push(out.relationBlocks, target, `  ${inverse}: ${kind === "oneToOne" ? "one" : "many"}(${ownerT}),`);
          out.needsRelationsImport.add(target);
        }
      } else if (kind === "oneToMany") {
        const fk = `${snakeColumn(inverse ?? owner.toLowerCase())}_id`;
        push(out.relationBlocks, owner, `  ${f.name}: many(${targetT}),`);
        out.needsRelationsImport.add(owner);
        push(out.fkColumns, target, `  ${fk}: ${fkType(dialect, fk)}.references(() => ${ownerT}.id),`);
        if (inverse) {
          push(out.relationBlocks, target, `  ${inverse}: one(${ownerT}, { fields: [${targetT}.${fk}], references: [${ownerT}.id] }),`);
          out.needsRelationsImport.add(target);
        }
      } else {
        const a = snakeColumn(owner);
        const b = snakeColumn(target);
        const [l, rr] = a < b ? [a, b] : [b, a];
        const pivot = `${l}_${rr}`;
        push(out.relationBlocks, owner, `  ${f.name}: many(${pivot}),`);
        out.needsRelationsImport.add(owner);
        if (inverse) {
          push(out.relationBlocks, target, `  ${inverse}: many(${pivot}),`);
          out.needsRelationsImport.add(target);
        }
        if (!seenPivot.has(pivot)) {
          seenPivot.add(pivot);
          // Junction table contributed as a synthetic content type's fkColumns under the pivot name.
          push(out.fkColumns, `__pivot__${pivot}`, `  ${a}_id: ${fkType(dialect, `${a}_id`)}.references(() => ${ownerT}.id),`);
          push(out.fkColumns, `__pivot__${pivot}`, `  ${b}_id: ${fkType(dialect, `${b}_id`)}.references(() => ${targetT}.id),`);
        }
      }
    }
  }
  return out;
};
```
Note: pivot tables for manyToMany are surfaced under `__pivot__<name>` keys; the schema emitter (Task 4) emits a table for each. For the test fixture (manyToOne only), pivots are unused.

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/relations.test.ts`; typecheck; lint.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/relations.ts packages/adapter-express/src/relations.test.ts
git commit -m "feat(adapter-express): resolve relations to Drizzle FK columns + relations()

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Dialect-aware schema emitter (`schema.ts`)

**Files:** Modify `packages/adapter-express/src/schema.ts`, `packages/adapter-express/src/schema.test.ts`.

- [ ] **Step 1: Failing test** — extend `schema.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitSchema } from "./schema";

const article: ContentType = { name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }] } as ContentType;

describe("emitSchema (dialect-aware)", () => {
  it("sqlite is 8A-compatible", () => {
    const ts = emitSchema(article, "sqlite", { fkColumns: [], relationBlock: undefined });
    expect(ts).toContain('import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";');
    expect(ts).toContain('export const articles = sqliteTable("articles", {');
    expect(ts).toContain('id: integer("id").primaryKey({ autoIncrement: true }),');
  });
  it("pg uses pgTable + serial + varchar", () => {
    const ts = emitSchema(article, "pgsql", { fkColumns: [], relationBlock: undefined });
    expect(ts).toContain('drizzle-orm/pg-core";');
    expect(ts).toContain("pgTable(");
    expect(ts).toContain('id: serial("id").primaryKey(),');
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/schema.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-express/src/schema.ts`
```ts
import { withMarker } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { DIALECTS, type Dialect } from "./dialect";
import { column, isSupportedField } from "./fields";
import { expressNames } from "./names";

export interface SchemaExtras {
  fkColumns: string[]; // pre-rendered FK column lines (from relations)
  relationBlock?: string; // a full `export const <table>Relations = relations(...)` block
}

export const emitSchema = (ct: ContentType, dialect: Dialect, extras: SchemaExtras): string => {
  const spec = DIALECTS[dialect];
  const n = expressNames(ct);
  const cols = ct.fields.filter((f) => isSupportedField(f.type)).map((f) => column(dialect, f));
  const ts1 = spec.timestamp("created_at");
  const ts2 = spec.timestamp("updated_at");
  const imports = [
    ...new Set([spec.tableFn, ...spec.idImports, ...cols.map((c) => c.import), ts1.import, ts2.import]),
  ]
    .sort()
    .join(", ");
  const colLines = cols.map((c) => `  ${c.column}: ${c.drizzle},`).join("\n");
  const fkLines = extras.fkColumns.join("\n");
  const body = [colLines, fkLines].filter((s) => s.length > 0).join("\n");
  const table = `export const ${n.table} = ${spec.tableFn}("${n.table}", {
  ${spec.idColumn},
${body}
  createdAt: ${ts1.expr},
  updatedAt: ${ts2.expr},
});`;
  const rel = extras.relationBlock ? `\n\n${extras.relationBlock}` : "";
  return withMarker(`import { ${imports} } from "${spec.core}";${extras.relationBlock ? `\nimport { relations } from "drizzle-orm";` : ""}

${table}${rel}
`);
};
```
(For sqlite with no FK/relations, the output must equal 8A's schema byte-for-byte — verify the Article golden in Task 9 stays unchanged. The `${body}` join collapses empty FK lines so the column block matches 8A.)

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/schema.test.ts`; typecheck.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/schema.ts packages/adapter-express/src/schema.test.ts
git commit -m "feat(adapter-express): dialect-aware schema emitter with FK + relations()

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Dialect-aware skeleton (`skeleton.ts`)

**Files:** Modify `packages/adapter-express/src/skeleton.ts`, `packages/adapter-express/src/skeleton.test.ts`.

- [ ] **Step 1: Failing test** — extend `skeleton.test.ts`:
```ts
it("pg skeleton uses postgres driver + dialect", () => {
  const files = skeletonFiles(doc, "blog", "pgsql");
  const c = (p: string) => files.find((f) => f.path === p)!.content;
  expect(JSON.parse(c("package.json")).dependencies["postgres"]).toBeDefined();
  expect(c("src/db/client.ts")).toContain("drizzle-orm/postgres-js");
  expect(c("drizzle.config.ts")).toContain('dialect: "postgresql"');
});
```
(Keep the existing 8A test but update `skeletonFiles(doc, "blog")` calls to `skeletonFiles(doc, "blog", "sqlite")`.)

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/skeleton.test.ts`.

- [ ] **Step 3: Modify `skeleton.ts`** — add a `dialect: Dialect` param to `skeletonFiles`, thread `DIALECTS[dialect]` into package.json (`...spec.driverDep` instead of the hard-coded better-sqlite3), client.ts (`spec.clientImports` + `spec.clientDb`), drizzle.config.ts (`spec.configDialect` + `spec.configCredentials`). The sqlite branch MUST reproduce 8A's files byte-for-byte (sqlite spec values equal the 8A literals). For sqlite, `.env` keeps `DB_FILE_NAME`; for pg/mysql, `.env` uses `DATABASE_URL=` (seed). Concretely:
```ts
import { DIALECTS, type Dialect } from "./dialect";
// PACKAGE_JSON(projectName, spec): dependencies merge { "drizzle-orm": ..., express: ..., ...spec.driverDep }
// CLIENT(spec): `${spec.clientImports}\nimport * as schema from "./schema";\n\nexport const db = ${spec.clientDb};`
// DRIZZLE_CONFIG(spec): defineConfig({ out, schema, dialect: spec.configDialect, ${spec.configCredentials} })
// ENV(spec): sqlite → "DB_FILE_NAME=./data.db\nPORT=3000\n"; else → "DATABASE_URL=\nPORT=3000\n"
export const skeletonFiles = (doc: IrDocument, projectName: string, dialect: Dialect): GeneratedFile[] => { /* as above, using DIALECTS[dialect] */ };
```
Implement the helpers to take `spec = DIALECTS[dialect]` and emit accordingly; for sqlite verify byte-identical to 8A.

- [ ] **Step 4: Run green + regression** — `pnpm --filter @camis/adapter-express test`; the Article sqlite goldens (Task 9 covers package.json/client/drizzle.config) must stay byte-identical once generate threads `"sqlite"`. typecheck; lint.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/skeleton.ts packages/adapter-express/src/skeleton.test.ts
git commit -m "feat(adapter-express): dialect-aware skeleton (driver/client/config)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Routes include FK columns

**Files:** Modify `packages/adapter-express/src/routes.ts`, `packages/adapter-express/src/routes.test.ts`.

- [ ] **Step 1: Failing test** — extend `routes.test.ts` to assert the FK column is in the pick-list when passed:
```ts
it("includes FK columns in the insertable pick-list", () => {
  const ts = emitRoutes(article, ["author_id"]);
  expect(ts).toContain('pick(req.body, ["title", "published", "author_id"]);');
});
```
(Update the existing `emitRoutes(article)` call to `emitRoutes(article, [])`.)

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/routes.test.ts`.

- [ ] **Step 3: Modify `emitRoutes`** — add `fkColumns: string[] = []`; append them to the pick-list cols:
```ts
export const emitRoutes = (ct: ContentType, fkColumns: string[] = []): string => {
  const n = expressNames(ct);
  const t = n.table;
  const cols = [...ct.fields.filter((f) => isSupportedField(f.type)).map((f) => snakeColumn(f.name)), ...fkColumns]
    .map((c) => `"${c}"`)
    .join(", ");
  // ... rest unchanged (use isSupportedField, not isSupported8A) ...
```
(Change the `isSupported8A` import to `isSupportedField`. For 8A's Article (no FK, `fkColumns=[]`), the routes output is byte-identical.)

- [ ] **Step 4: Run green + regression** — `pnpm --filter @camis/adapter-express test` (Article routes golden unchanged); typecheck; lint.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/routes.ts packages/adapter-express/src/routes.test.ts
git commit -m "feat(adapter-express): include relation FK columns in route pick-list

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Round-trip artifact + importer (`import.ts`)

**Files:** Create `packages/adapter-express/src/import.ts`, `packages/adapter-express/src/import.test.ts`.

- [ ] **Step 1: Failing test** `packages/adapter-express/src/import.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import type { IrDocument } from "@camis/ir-schema";
import { camisSchemaFile, importExpressProject } from "./import";

const doc: IrDocument = { version: 1, contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }] }], components: [] };

describe("round-trip", () => {
  it("camisSchemaFile emits a declarative JSON of the document", () => {
    const f = camisSchemaFile(doc);
    expect(f.path).toBe("camis.schema.json");
    expect(JSON.parse(f.content).contentTypes[0].name).toBe("Article");
  });
  it("import(generate's camis.schema.json) normalizes back to the same IR", () => {
    const f = camisSchemaFile(normalize(doc));
    const r = importExpressProject([f]);
    expect(r.document.ok).toBe(true);
    if (r.document.ok) expect(normalize(r.document.value)).toEqual(normalize(doc));
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/import.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-express/src/import.ts`
```ts
import { stableJson, type GeneratedFile } from "@camis/adapter-kernel";
import { fail, type IrDocument, type Result, parseDocument } from "@camis/ir-schema";

export const camisSchemaFile = (doc: IrDocument): GeneratedFile => ({
  path: "camis.schema.json",
  content: stableJson(doc) + "\n",
});

export const importExpressProject = (files: { path: string; content: string }[]): { document: Result<IrDocument> } => {
  const f = files.find((x) => x.path === "camis.schema.json");
  if (!f) {
    return {
      document: fail([{ code: "invalid_document", message: "camis.schema.json not found", location: {}, path: [] }]),
    };
  }
  return { document: parseDocument(JSON.parse(f.content)) };
};
```
(Confirm `parseDocument` is exported from `@camis/ir-schema` and returns `Result<IrDocument>`; it is — `index.ts` exports `parseDocument`. If its signature differs, use `irDocument.safeParse` and map to `Result`.)

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/import.test.ts`; typecheck; lint.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/import.ts packages/adapter-express/src/import.test.ts
git commit -m "feat(adapter-express): camis.schema.json artifact + round-trip importer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: `expressAdapterFor` factory + orchestration (`generate.ts`)

**Files:** Modify `packages/adapter-express/src/generate.ts`, `packages/adapter-express/src/index.ts`, `packages/adapter-express/src/generate.test.ts`.

- [ ] **Step 1: Failing test** — extend `generate.test.ts`:
```ts
import { expressAdapter, expressAdapterFor } from "./generate";

describe("expressAdapterFor", () => {
  const relBundle = { document: { version: 1, contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }, { type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" }, { type: "component", name: "seo", component: "Seo", repeatable: false }] },
    { name: "Author", kind: "collection", fields: [{ type: "string", name: "name", required: true }] },
  ], components: [] }, roles: [] } as never;

  it("default export targets sqlite", () => {
    expect(expressAdapter.target).toBe("express");
  });
  it("pg adapter emits a pg schema + camis.schema.json + relation FK + component gap", () => {
    const result = expressAdapterFor("pgsql").generate(relBundle, { projectName: "blog" });
    const schema = result.files.find((f) => f.path === "src/db/schema.ts")!.content;
    expect(schema).toContain("pgTable(");
    expect(schema).toContain("author_id: integer('author_id').references(() => authors.id)");
    expect(result.files.some((f) => f.path === "camis.schema.json")).toBe(true);
    expect(result.gaps.gaps.some((g) => g.feature === "component")).toBe(true);
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/generate.test.ts`.

- [ ] **Step 3: Rewrite `generate.ts`** to the factory:
```ts
import { buildManifest, type GenerateAdapter, type GeneratedFile, type GenerationResult } from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap, ContentType } from "@camis/ir-schema";
import { type Dialect } from "./dialect";
import { isSupportedField } from "./fields";
import { camisSchemaFile } from "./import";
import { expressNames } from "./names";
import { resolveRelations } from "./relations";
import { emitRoutes } from "./routes";
import { emitSchema } from "./schema";
import { skeletonFiles } from "./skeleton";

const fkNames = (lines: string[]): string[] =>
  lines.map((l) => l.trim().split(":")[0]!.trim()); // "author_id: integer(...)" → "author_id"

export const expressAdapterFor = (dialect: Dialect): GenerateAdapter => ({
  target: "express",
  generate: (ir, options): GenerationResult => {
    const doc = normalize(ir.document);
    const rel = resolveRelations(doc, dialect);
    const gaps: CapabilityGap[] = [];
    const files: GeneratedFile[] = [...skeletonFiles(doc, options.projectName, dialect)];

    // one schema file aggregating all tables + pivot tables + relations() blocks
    const schemaParts: string[] = [];
    doc.contentTypes.forEach((ct) => {
      for (const f of ct.fields) {
        if (f.type === "relation") continue;
        if (!isSupportedField(f.type)) {
          gaps.push({ feature: f.type, location: { contentType: ct.name, field: f.name }, severity: "downgrade", message: `field type "${f.type}" is not supported by the Express target` });
        }
      }
      const fk = rel.fkColumns.get(ct.name) ?? [];
      const blocks = rel.relationBlocks.get(ct.name);
      const relationBlock = blocks && blocks.length > 0
        ? `export const ${expressNames(ct).table}Relations = relations(${expressNames(ct).table}, ({ one, many }) => ({\n${blocks.join("\n")}\n}));`
        : undefined;
      schemaParts.push(emitSchema(ct, dialect, { fkColumns: fk, ...(relationBlock ? { relationBlock } : {}) }));
      files.push({ path: `src/routes/${expressNames(ct).table}.ts`, content: emitRoutes(ct, fkNames(fk)) });
    });

    files.push({ path: "src/db/schema.ts", content: schemaParts.join("\n") });
    files.push(camisSchemaFile(doc));

    return { files, manifest: buildManifest(files), gaps: { target: "express", gaps } };
  },
});

export const expressAdapter = expressAdapterFor("sqlite");
```
Note: pivot tables (`__pivot__*` keys from `resolveRelations`) are NOT emitted as their own schema tables in this task's minimal version — manyToMany junction-table emission is covered by extending the schema-parts loop to also emit a `sqliteTable`/`pgTable` for each `__pivot__` key; add that here (iterate `rel.fkColumns` keys starting with `__pivot__`, emit a table named after the pivot). The relation test fixture uses manyToOne, so the minimal version passes; ADD the pivot emission so manyToMany in the golden fixture (Task 9) works.

- [ ] **Step 4: index** — `packages/adapter-express/src/index.ts`:
```ts
export { expressAdapter, expressAdapterFor } from "./generate";
export { importExpressProject } from "./import";
```

- [ ] **Step 5: Run green + regression** — `pnpm --filter @camis/adapter-express test` (Article sqlite goldens UNCHANGED — default `expressAdapter` is sqlite, no relations, and `camis.schema.json` is a NEW file so the existing per-file goldens are unaffected; but the FILE-LISTING golden gains `camis.schema.json` → that golden WILL change). Handle the file-listing golden in Task 9 (regenerate it to include `camis.schema.json`); the per-file content goldens (schema/routes/server/client/package.json) stay byte-identical. typecheck; lint.

- [ ] **Step 6: Commit**
```bash
git add packages/adapter-express/src/generate.ts packages/adapter-express/src/index.ts packages/adapter-express/src/generate.test.ts
git commit -m "feat(adapter-express): expressAdapterFor(dialect) factory + relations + camis.schema.json

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Richer fixture + goldens + round-trip + regression

**Files:** Create `packages/adapter-express/src/__fixtures__/catalog.ts`, `packages/adapter-express/src/catalog-golden.test.ts`, `packages/adapter-express/src/roundtrip.test.ts`; update the 8A `file-listing.txt` golden.

- [ ] **Step 1: Fixture** `packages/adapter-express/src/__fixtures__/catalog.ts` — `Article` (full-taxonomy scalars + a `manyToOne` author + a `manyToMany` tags + a `component` to gap), `Author`, `Tag` (sqlite via `expressAdapter`). Provide a concrete `IrBundle` with: title(string,required), body(richText), status(enumeration values draft/published), price(decimal), meta(json), publishedAt(dateTime), author(relation manyToOne→Author inverse articles), tags(relation manyToMany→Tag inverse articles), seo(component); Author{name(string,required)}; Tag{label(string,required)}.

- [ ] **Step 2: Golden + round-trip tests** — `catalog-golden.test.ts` snapshots `src/db/schema.ts` (`./__golden__/catalog/schema.ts.txt`), `src/routes/articles.ts`, `camis.schema.json`, file-listing, and asserts idempotency + that `gaps` contains a `component` gap. `roundtrip.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import { expressAdapter, importExpressProject } from "./index";
import { catalog } from "./__fixtures__/catalog";

describe("express round-trip", () => {
  it("import(generate.camis.schema.json) normalizes back to the IR", () => {
    const files = expressAdapter.generate(catalog, { projectName: "blog" }).files;
    const r = importExpressProject(files);
    expect(r.document.ok).toBe(true);
    if (r.document.ok) expect(normalize(r.document.value)).toEqual(normalize(catalog.document));
  });
});
```

- [ ] **Step 3: Generate + INSPECT + regression** — `... vitest run src/catalog-golden.test.ts -u`. Read the catalog schema golden: pgTable? no — `expressAdapter` is sqlite, so `sqliteTable`; FK `author_id: integer('author_id').references(() => authors.id)`; a pivot `article_tag` table; `relations()` blocks for articles/authors/tags; richText→text, enumeration→text, decimal→numeric, json→text json mode, dateTime→integer timestamp. Then update the 8A `file-listing.txt` golden to include `camis.schema.json` (`vitest run src/golden.test.ts -u` and confirm ONLY `file-listing.txt` changed — the other 8A goldens byte-identical). `pnpm --filter @camis/adapter-express test`; `git status --short src/__golden__/` shows only the new catalog goldens + the file-listing change.

- [ ] **Step 4: Run green** — whole package; typecheck; lint.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/__fixtures__/catalog.ts packages/adapter-express/src/catalog-golden.test.ts packages/adapter-express/src/roundtrip.test.ts packages/adapter-express/src/__golden__
git commit -m "test(adapter-express): catalog goldens (relations, full types) + round-trip

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: 3-DB gated boot matrix + sweep

**Files:** Modify `packages/adapter-express/scripts/boot-smoke.ts`, `.github/workflows/adapter-express-boot.yml`.

- [ ] **Step 1: Boot smoke takes a dialect** — modify `scripts/boot-smoke.ts` to read `process.argv[2]` as the dialect (default `sqlite`), use `expressAdapterFor(dialect)` with the `catalog` fixture, and set the DB env per dialect (sqlite: DB_FILE_NAME + touch; pg: DATABASE_URL postgres; mysql: DATABASE_URL mysql). Keep the readiness-poll loop. The CRUD round-trip now POSTs an Article including `author_id` after creating an Author (or just posts scalars + asserts list works — keep it to a scalar create + the relation FK column existing in the schema; a full relational insert needs an Author row first: create Author, then Article with author_id, GET it back).

- [ ] **Step 2: Workflow matrix** — `.github/workflows/adapter-express-boot.yml`: add `strategy.matrix.dialect: [sqlite, mysql, pgsql]` + mysql:8 / postgres:16 service containers (mirror `adapter-filament-boot.yml`); the run step becomes `pnpm --filter @camis/adapter-express smoke ${{ matrix.dialect }}` with the matching `DATABASE_URL` exported per dialect.

- [ ] **Step 3: Full sweep** — `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test` (all green; report counts). Confirm the only golden changes are the catalog goldens + the 8A file-listing. Do NOT run the gated workflow locally.

- [ ] **Step 4: Commit**
```bash
git add packages/adapter-express/scripts/boot-smoke.ts .github/workflows/adapter-express-boot.yml
git commit -m "ci(adapter-express): 3-dialect gated boot matrix

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** D1 single-dialect project / 3× boot (Tasks 8,10) · D2 `expressAdapterFor` factory, no kernel leak (Task 8) · D3 `column(dialect, field)` map (Task 2) · D4 relations FK + relations() (Tasks 3,4) · D5 round-trip via `camis.schema.json` (Tasks 7,9) · D6 component/dynamicZone gap (Task 8) · D7 sqlite goldens + pg/mysql unit tests (Tasks 2,4,9). Exit criteria: full taxonomy + relations golden+idempotent (Task 9); pg/mysql valid + gated 3-DB boot (Tasks 2,4,10); round-trip (Tasks 7,9); 8A goldens byte-identical except file-listing (Tasks 2,4,5,6,8 regression checks).

**Placeholder scan:** Tasks 5 and 10 describe helper/skeleton modifications structurally rather than full literal code (the sqlite branch must reproduce 8A byte-for-byte, so the implementer mirrors the existing literals through the `DialectSpec`); this is a guided modification of existing code, not a placeholder. Task 2's `base` switch is complete; remove the illustrative `text`/`imp` locals. The catalog fixture (Task 9 Step 1) is described field-by-field with exact types — the implementer writes the literal `IrBundle`.

**Type consistency:** `Dialect`/`DialectSpec`/`DIALECTS` (Task 1) used by fields (2), relations (3), schema (4), skeleton (5), generate (8). `column(dialect, field)`/`isSupportedField` (2) → schema (4), routes (6), generate (8). `resolveRelations(doc, dialect) → { fkColumns, relationBlocks, needsRelationsImport }` (3) → generate (8). `emitSchema(ct, dialect, { fkColumns, relationBlock? })` (4), `emitRoutes(ct, fkColumns?)` (6), `skeletonFiles(doc, projectName, dialect)` (5) → generate (8). `camisSchemaFile`/`importExpressProject` (7) → generate (8), index, round-trip (9). `expressAdapterFor`/`expressAdapter` (8).

**Risk note:** the emitted pg/mysql Drizzle column expressions + relations() + the junction-table emission are validated only by the gated 3-DB boot; per-commit tests prove the sqlite goldens + the pg/mysql column unit fragments + round-trip + idempotency. If the gated boot reveals a Drizzle pg/mysql API mismatch (e.g. `serial` vs `integer().generatedAlwaysAsIdentity()`, `bigint` mode, `numeric` precision), fix `dialect.ts`/`fields.ts` and regenerate the (sqlite) goldens.
