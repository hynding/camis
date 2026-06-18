# Phase 8A — Express + Drizzle API Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a complete, bootable from-scratch TypeScript Express + Drizzle (sqlite) project from the IR for one content type (`Article`, scalar fields) — schema, REST CRUD routes, and the full project skeleton.

**Architecture:** A new `@camis/adapter-express` package, a `GenerateAdapter` that emits the entire bootable Node/TS tree (no framework installer). Pure string emitters produce the Drizzle sqlite schema, an Express CRUD router per content type, and the skeleton. Golden + structural tests per commit; a gated CI job installs, `drizzle-kit push`es the schema, boots the API, and round-trips a CRUD request.

**Tech Stack:** TypeScript (strict, ESM), Vitest (`toMatchFileSnapshot`); emitted TS for Node 22 + Express 4 + drizzle-orm + better-sqlite3 + drizzle-kit, run via `tsx`.

**Design spec:** `docs/superpowers/specs/2026-06-18-phase-8a-express-drizzle-slice-design.md`

> **Notes:** better-sqlite3 + Drizzle is SYNCHRONOUS — emitted routes use `.all()`/`.get()`/`.run()`, NOT `await`. Migrations are not emitted (the boot runs `drizzle-kit push`). All emitted TS carries the `withMarker` header; `.env` is `mode:"seed"`. The gated boot is the integration oracle for the emitted source's runtime validity.

---

## File structure (`packages/adapter-express/`)

- `package.json` — add deps; `src/index.ts` — exports.
- `src/names.ts` — `expressNames(ct)` (table/route names) + `snakeColumn`.
- `src/fields.ts` — scalar field → Drizzle column fragment (`emitColumn`, `isSupported8A`).
- `src/schema.ts` — `emitSchema(ct)` (Drizzle sqlite table).
- `src/routes.ts` — `emitRoutes(ct)` (Express CRUD router).
- `src/skeleton.ts` — package.json/tsconfig/drizzle.config/.env/client.ts/server.ts/index.ts emitters.
- `src/generate.ts` — `expressAdapter`; `src/__fixtures__/blog.ts`; tests + `__golden__/`.
- `scripts/boot-smoke.ts` — gated boot script; `.github/workflows/adapter-express-boot.yml`.

---

## Task 1: Package scaffold

**Files:** Modify `packages/adapter-express/package.json`, `packages/adapter-express/src/index.ts`.

- [ ] **Step 1: Add deps** — Run (QUOTE the specs — zsh globs `*`):
```bash
pnpm --filter @camis/adapter-express add "@camis/adapter-kernel@workspace:*" "@camis/ir-schema@workspace:*" "@camis/ir-core@workspace:*" "@camis/permissions@workspace:*"
```
Confirm all four appear in dependencies.

- [ ] **Step 2: Placeholder export** — set `packages/adapter-express/src/index.ts` to `export {};` (real exports in Task 7).

- [ ] **Step 3: Typecheck** — `pnpm --filter @camis/adapter-express typecheck` (clean).

- [ ] **Step 4: Commit**
```bash
git add packages/adapter-express/package.json packages/adapter-express/src/index.ts pnpm-lock.yaml
git commit -m "chore(adapter-express): wire package dependencies

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Naming (`names.ts`)

**Files:** Create `packages/adapter-express/src/names.ts`, `packages/adapter-express/src/names.test.ts`.

- [ ] **Step 1: Failing test** `packages/adapter-express/src/names.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { expressNames, snakeColumn } from "./names";

const ct = (name: string, plural?: string): ContentType =>
  ({ name, kind: "collection", fields: [], ...(plural ? { names: { plural } } : {}) }) as ContentType;

describe("names", () => {
  it("derives table + route names", () => {
    expect(expressNames(ct("Article"))).toEqual({ table: "articles", routeBase: "articles" });
    expect(expressNames(ct("BlogPost")).table).toBe("blog_posts");
  });
  it("honors an explicit plural", () => {
    expect(expressNames(ct("Category", "Categories")).table).toBe("categories");
  });
  it("snakeColumn snake-cases field names", () => {
    expect(snakeColumn("publishedAt")).toBe("published_at");
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/names.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-express/src/names.ts`
```ts
import type { ContentType } from "@camis/ir-schema";

const snake = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();

const pluralize = (word: string): string => {
  if (/[^aeiou]y$/.test(word)) return word.replace(/y$/, "ies");
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
};

export const snakeColumn = (fieldName: string): string => snake(fieldName);

export interface ExpressNames {
  table: string;
  routeBase: string;
}

export const expressNames = (ct: ContentType): ExpressNames => {
  const singular = snake(ct.name);
  const plural = ct.names?.plural ? snake(ct.names.plural) : pluralize(singular);
  return { table: plural, routeBase: plural };
};
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/names.test.ts`; `pnpm --filter @camis/adapter-express typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/names.ts packages/adapter-express/src/names.test.ts
git commit -m "feat(adapter-express): table/route naming helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Field → Drizzle column (`fields.ts`)

**Files:** Create `packages/adapter-express/src/fields.ts`, `packages/adapter-express/src/fields.test.ts`.

- [ ] **Step 1: Failing test** `packages/adapter-express/src/fields.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { emitColumn, isSupported8A } from "./fields";

describe("emitColumn", () => {
  it("maps a required unique string to text().notNull().unique()", () => {
    const c = emitColumn({ type: "string", name: "title", required: true, unique: true } as Field);
    expect(c.column).toBe("title");
    expect(c.drizzle).toBe("text('title').notNull().unique()");
    expect(c.import).toBe("text");
  });
  it("maps boolean and dateTime with modes", () => {
    expect(emitColumn({ type: "boolean", name: "published" } as Field).drizzle).toBe("integer('published', { mode: 'boolean' })");
    expect(emitColumn({ type: "dateTime", name: "publishedAt" } as Field).drizzle).toBe("integer('published_at', { mode: 'timestamp' })");
  });
  it("isSupported8A gates the subset", () => {
    expect(isSupported8A("string")).toBe(true);
    expect(isSupported8A("relation")).toBe(false);
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/fields.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-express/src/fields.ts`
```ts
import type { Field } from "@camis/ir-schema";
import { snakeColumn } from "./names";

const SUPPORTED = new Set<string>(["string", "text", "email", "uid", "integer", "float", "boolean", "dateTime"]);
export const isSupported8A = (t: string): boolean => SUPPORTED.has(t);

export interface ColumnEmit {
  column: string;
  drizzle: string;
  import: "text" | "integer" | "real";
}

const phpLiteral = (v: unknown): string =>
  typeof v === "boolean" ? (v ? "true" : "false") : typeof v === "number" ? String(v) : `'${String(v)}'`;

export const emitColumn = (field: Field): ColumnEmit => {
  const f = field as Field & Record<string, unknown>;
  const c = snakeColumn(field.name);
  let base: string;
  let imp: ColumnEmit["import"];
  switch (field.type) {
    case "integer":
      base = `integer('${c}')`;
      imp = "integer";
      break;
    case "float":
      base = `real('${c}')`;
      imp = "real";
      break;
    case "boolean":
      base = `integer('${c}', { mode: 'boolean' })`;
      imp = "integer";
      break;
    case "dateTime":
      base = `integer('${c}', { mode: 'timestamp' })`;
      imp = "integer";
      break;
    default:
      // string | text | email | uid
      base = `text('${c}')`;
      imp = "text";
  }
  const drizzle =
    base +
    (f.required === true ? ".notNull()" : "") +
    (f.unique === true ? ".unique()" : "") +
    (f.default !== undefined ? `.default(${phpLiteral(f.default)})` : "");
  return { column: c, drizzle, import: imp };
};
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/fields.test.ts`; `pnpm --filter @camis/adapter-express typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/fields.ts packages/adapter-express/src/fields.test.ts
git commit -m "feat(adapter-express): scalar field to Drizzle sqlite column

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Drizzle schema emitter (`schema.ts`)

**Files:** Create `packages/adapter-express/src/schema.ts`, `packages/adapter-express/src/schema.test.ts`.

- [ ] **Step 1: Failing test** `packages/adapter-express/src/schema.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitSchema } from "./schema";

const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "string", name: "title", required: true },
    { type: "boolean", name: "published" },
  ],
} as ContentType;

describe("emitSchema", () => {
  const ts = emitSchema(article);
  it("emits a marked sqliteTable with id, columns, and timestamps", () => {
    expect(ts).toContain("@camis:generated");
    expect(ts).toContain('import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";');
    expect(ts).toContain('export const articles = sqliteTable("articles", {');
    expect(ts).toContain('id: integer("id").primaryKey({ autoIncrement: true }),');
    expect(ts).toContain("title: text('title').notNull(),");
    expect(ts).toContain("published: integer('published', { mode: 'boolean' }),");
    expect(ts).toContain('createdAt: integer("created_at", { mode: "timestamp" }),');
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/schema.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-express/src/schema.ts`
```ts
import { withMarker } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { emitColumn, isSupported8A } from "./fields";
import { expressNames } from "./names";

export const emitSchema = (ct: ContentType): string => {
  const n = expressNames(ct);
  // 8A: only supported scalar fields become columns; unsupported types are gapped in generate.ts.
  const cols = ct.fields.filter((f) => isSupported8A(f.type)).map(emitColumn);
  const imports = [...new Set(["sqliteTable", "integer", ...cols.map((c) => c.import)])].sort().join(", ");
  const colLines = cols.map((c) => `  ${c.column}: ${c.drizzle},`).join("\n");
  return withMarker(`import { ${imports} } from "drizzle-orm/sqlite-core";

export const ${n.table} = sqliteTable("${n.table}", {
  id: integer("id").primaryKey({ autoIncrement: true }),
${colLines}
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});
`);
};
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/schema.test.ts`; typecheck.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/schema.ts packages/adapter-express/src/schema.test.ts
git commit -m "feat(adapter-express): Drizzle sqlite schema emitter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Express CRUD router emitter (`routes.ts`)

**Files:** Create `packages/adapter-express/src/routes.ts`, `packages/adapter-express/src/routes.test.ts`.

- [ ] **Step 1: Failing test** `packages/adapter-express/src/routes.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitRoutes } from "./routes";

const article: ContentType = { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }, { type: "boolean", name: "published" }] } as ContentType;

describe("emitRoutes", () => {
  const ts = emitRoutes(article);
  it("emits a marked CRUD router using sync better-sqlite3 calls", () => {
    expect(ts).toContain("@camis:generated");
    expect(ts).toContain("export const articlesRouter = Router();");
    expect(ts).toContain("db.select().from(articles).all()");
    expect(ts).toContain("db.insert(articles).values(data).returning().get()");
    expect(ts).toContain('const data = pick(req.body, ["title", "published"]);');
    expect(ts).toContain("db.delete(articles).where(eq(articles.id, Number(req.params.id))).run();");
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/routes.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-express/src/routes.ts`
```ts
import { withMarker } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { isSupported8A } from "./fields";
import { expressNames, snakeColumn } from "./names";

export const emitRoutes = (ct: ContentType): string => {
  const n = expressNames(ct);
  const t = n.table;
  const cols = ct.fields
    .filter((f) => isSupported8A(f.type))
    .map((f) => `"${snakeColumn(f.name)}"`)
    .join(", ");
  return withMarker(`import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { ${t} } from "../db/schema";

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

export const ${t}Router = Router();

${t}Router.get("/", (_req, res) => {
  res.json(db.select().from(${t}).all());
});

${t}Router.get("/:id", (req, res) => {
  const row = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(row);
});

${t}Router.post("/", (req, res) => {
  const data = pick(req.body, [${cols}]);
  const row = db.insert(${t}).values(data).returning().get();
  res.status(201).json(row);
});

${t}Router.patch("/:id", (req, res) => {
  const data = pick(req.body, [${cols}]);
  const row = db.update(${t}).set(data).where(eq(${t}.id, Number(req.params.id))).returning().get();
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(row);
});

${t}Router.delete("/:id", (req, res) => {
  db.delete(${t}).where(eq(${t}.id, Number(req.params.id))).run();
  res.status(204).end();
});
`);
};
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/routes.test.ts`; typecheck.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/routes.ts packages/adapter-express/src/routes.test.ts
git commit -m "feat(adapter-express): Express CRUD router emitter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Skeleton emitters (`skeleton.ts`)

**Files:** Create `packages/adapter-express/src/skeleton.ts`, `packages/adapter-express/src/skeleton.test.ts`.

- [ ] **Step 1: Failing test** `packages/adapter-express/src/skeleton.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { skeletonFiles } from "./skeleton";

const doc: IrDocument = { version: 1, contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] }], components: [] };

describe("skeletonFiles", () => {
  const files = skeletonFiles(doc, "blog");
  const c = (p: string) => files.find((f) => f.path === p)!.content;
  it("emits package.json with deps + scripts", () => {
    const pkg = JSON.parse(c("package.json"));
    expect(pkg.name).toBe("blog");
    expect(pkg.dependencies["drizzle-orm"]).toBeDefined();
    expect(pkg.scripts["db:push"]).toBe("drizzle-kit push");
  });
  it("emits drizzle.config, client, server (mounting the router), index, .env (seed)", () => {
    expect(c("drizzle.config.ts")).toContain('dialect: "sqlite"');
    expect(c("src/db/client.ts")).toContain("drizzle(new Database(");
    expect(c("src/server.ts")).toContain('app.use("/api/articles", articlesRouter);');
    expect(c("src/index.ts")).toContain("app.listen(");
    const env = files.find((f) => f.path === ".env")!;
    expect(env.mode).toBe("seed");
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/skeleton.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-express/src/skeleton.ts`
```ts
import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { expressNames } from "./names";

const PACKAGE_JSON = (projectName: string): string =>
  JSON.stringify(
    {
      name: projectName,
      private: true,
      type: "module",
      scripts: { dev: "tsx watch src/index.ts", start: "tsx src/index.ts", "db:push": "drizzle-kit push" },
      dependencies: { "better-sqlite3": "^11.8.0", "drizzle-orm": "^0.38.0", express: "^4.21.0" },
      devDependencies: {
        "@types/better-sqlite3": "^7.6.0",
        "@types/express": "^4.17.0",
        "@types/node": "^22.0.0",
        "drizzle-kit": "^0.30.0",
        tsx: "^4.19.0",
        typescript: "^5.7.0",
      },
    },
    null,
    2,
  ) + "\n";

const TSCONFIG = JSON.stringify(
  { compilerOptions: { target: "ESNext", module: "NodeNext", moduleResolution: "NodeNext", strict: true, esModuleInterop: true, skipLibCheck: true, outDir: "dist" }, include: ["src"] },
  null,
  2,
) + "\n";

const DRIZZLE_CONFIG = withMarker(`import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/db/schema.ts",
  dialect: "sqlite",
  dbCredentials: { url: process.env.DB_FILE_NAME ?? "./data.db" },
});
`);

const CLIENT = withMarker(`import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export const db = drizzle(new Database(process.env.DB_FILE_NAME ?? "./data.db"), { schema });
`);

const INDEX = withMarker(`import { app } from "./server";

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(\`listening on \${port}\`));
`);

const ENV = `DB_FILE_NAME=./data.db\nPORT=3000\n`;

const emitServer = (doc: IrDocument): string => {
  const cts = doc.contentTypes;
  const imports = cts.map((ct) => `import { ${expressNames(ct).table}Router } from "./routes/${expressNames(ct).table}";`).join("\n");
  const mounts = cts.map((ct) => `app.use("/api/${expressNames(ct).routeBase}", ${expressNames(ct).table}Router);`).join("\n");
  return withMarker(`import express from "express";
${imports}

export const app = express();
app.use(express.json());
${mounts}
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});
`);
};

export const skeletonFiles = (doc: IrDocument, projectName: string): GeneratedFile[] => [
  { path: "package.json", content: PACKAGE_JSON(projectName) },
  { path: "tsconfig.json", content: TSCONFIG },
  { path: "drizzle.config.ts", content: DRIZZLE_CONFIG },
  { path: "src/db/client.ts", content: CLIENT },
  { path: "src/server.ts", content: emitServer(doc) },
  { path: "src/index.ts", content: INDEX },
  { path: ".env", content: ENV, mode: "seed" },
];
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/skeleton.test.ts`; typecheck.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/skeleton.ts packages/adapter-express/src/skeleton.test.ts
git commit -m "feat(adapter-express): bootable project skeleton emitters

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `expressAdapter` assembly (`generate.ts`) + index

**Files:** Create `packages/adapter-express/src/generate.ts`, `packages/adapter-express/src/generate.test.ts`; Modify `packages/adapter-express/src/index.ts`.

- [ ] **Step 1: Failing test** `packages/adapter-express/src/generate.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { expressAdapter } from "./generate";

const bundle: IrBundle = {
  document: { version: 1, contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }, { type: "relation", name: "x", relationKind: "manyToOne", target: "Tag" }] }], components: [] },
  roles: [],
};

describe("expressAdapter", () => {
  const result = expressAdapter.generate(bundle, { projectName: "blog" });
  const paths = result.files.map((f) => f.path);
  it("emits the skeleton + schema + routes", () => {
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/db/schema.ts");
    expect(paths).toContain("src/routes/articles.ts");
    expect(paths).toContain("src/server.ts");
  });
  it("builds a manifest and gaps a non-subset field type", () => {
    expect(result.manifest.files.length).toBe(result.files.length);
    expect(result.gaps.gaps.some((g) => g.feature === "relation")).toBe(true);
  });
  it("is idempotent", () => {
    expect(expressAdapter.generate(bundle, { projectName: "blog" })).toEqual(result);
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/generate.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-express/src/generate.ts`
```ts
import { buildManifest, type GenerateAdapter, type GeneratedFile, type GenerationResult } from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap } from "@camis/ir-schema";
import { isSupported8A } from "./fields";
import { expressNames } from "./names";
import { emitRoutes } from "./routes";
import { emitSchema } from "./schema";
import { skeletonFiles } from "./skeleton";

export const expressAdapter: GenerateAdapter = {
  target: "express",
  generate: (ir, options): GenerationResult => {
    const doc = normalize(ir.document);
    const gaps: CapabilityGap[] = [];
    const files: GeneratedFile[] = [...skeletonFiles(doc, options.projectName)];

    // 8A: a single Drizzle schema file aggregating all content types' tables.
    const schemas = doc.contentTypes.map((ct) => emitSchema(ct)).join("\n");
    files.push({ path: "src/db/schema.ts", content: schemas });

    for (const ct of doc.contentTypes) {
      for (const f of ct.fields) {
        if (!isSupported8A(f.type)) {
          gaps.push({
            feature: f.type,
            location: { contentType: ct.name, field: f.name },
            severity: "downgrade",
            message: `field type "${f.type}" is not supported in Phase 8A (scalars only)`,
          });
        }
      }
      files.push({ path: `src/routes/${expressNames(ct).table}.ts`, content: emitRoutes(ct) });
    }

    return { files, manifest: buildManifest(files), gaps: { target: "express", gaps } };
  },
};
```
Note: `emitSchema` (Task 4) and `emitRoutes` (Task 5) already `filter((f) => isSupported8A(f.type))`, so a gapped non-subset field (e.g. the `relation` in this test) does NOT emit a column — it only produces a capability-gap here. The Article golden fixture has only supported fields, so its goldens are unaffected.

- [ ] **Step 4: Public surface** — set `packages/adapter-express/src/index.ts`:
```ts
export { expressAdapter } from "./generate";
```

- [ ] **Step 5: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/generate.test.ts`; `pnpm --filter @camis/adapter-express test`; typecheck; lint.

- [ ] **Step 6: Commit**
```bash
git add packages/adapter-express/src
git commit -m "feat(adapter-express): expressAdapter assembles the bootable project

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Fixture + goldens

**Files:** Create `packages/adapter-express/src/__fixtures__/blog.ts`, `packages/adapter-express/src/golden.test.ts`, generated `src/__golden__/*`.

- [ ] **Step 1: Fixture** `packages/adapter-express/src/__fixtures__/blog.ts`
```ts
import type { IrBundle } from "@camis/permissions";

export const blog: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      { name: "Article", kind: "collection", fields: [
        { type: "string", name: "title", required: true },
        { type: "text", name: "body" },
        { type: "boolean", name: "published" },
        { type: "dateTime", name: "publishedAt" },
      ] },
    ],
    components: [],
  },
  roles: [],
};
```

- [ ] **Step 2: Golden test** `packages/adapter-express/src/golden.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { expressAdapter } from "./generate";
import { blog } from "./__fixtures__/blog";

describe("express golden", () => {
  const result = expressAdapter.generate(blog, { projectName: "blog" });
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("schema golden", async () => { await expect(c("src/db/schema.ts")).toMatchFileSnapshot("./__golden__/schema.ts.txt"); });
  it("routes golden", async () => { await expect(c("src/routes/articles.ts")).toMatchFileSnapshot("./__golden__/articles.routes.ts.txt"); });
  it("server golden", async () => { await expect(c("src/server.ts")).toMatchFileSnapshot("./__golden__/server.ts.txt"); });
  it("client golden", async () => { await expect(c("src/db/client.ts")).toMatchFileSnapshot("./__golden__/client.ts.txt"); });
  it("package.json golden", async () => { await expect(c("package.json")).toMatchFileSnapshot("./__golden__/package.json"); });
  it("file listing golden", async () => { await expect(result.files.map((f) => `${f.mode ?? "overwrite"} ${f.path}`).sort().join("\n")).toMatchFileSnapshot("./__golden__/file-listing.txt"); });
  it("idempotent", () => { expect(expressAdapter.generate(blog, { projectName: "blog" })).toEqual(result); });
});
```
(Goldens for `.ts` outputs use a `.ts.txt` extension so tsconfig `include:["src"]` does not compile them as source — matching the Strapi/Filament convention.)

- [ ] **Step 3: Generate + INSPECT** — `pnpm --filter @camis/adapter-express exec vitest run src/golden.test.ts -u`. Read `src/__golden__/`: the schema (sqliteTable, columns with notNull, timestamps, marked), routes (sync `.all()/.get()/.run()`, marked), server (mounts `/api/articles`), client, package.json (deps + db:push), file-listing (all files). If anything is structurally wrong, STOP and report (emitter bug).

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express test`; typecheck; lint.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/src/__fixtures__ packages/adapter-express/src/golden.test.ts packages/adapter-express/src/__golden__
git commit -m "test(adapter-express): Article golden snapshots + idempotent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Gated boot smoke + sweep

**Files:** Create `packages/adapter-express/scripts/boot-smoke.ts`, `.github/workflows/adapter-express-boot.yml`; Modify `packages/adapter-express/package.json` (smoke script + tsx devDep).

- [ ] **Step 1: Boot smoke script** `packages/adapter-express/scripts/boot-smoke.ts`
```ts
// Generates, materializes, installs, pushes the schema, boots the API, and round-trips a CRUD request.
// Runs ONLY in the gated CI job (needs npm + a running server). Not run in the dev sandbox.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import { expressAdapter } from "../src/generate";
import { blog } from "../src/__fixtures__/blog";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), "camis-express-"));
let proc: ChildProcess | undefined;
try {
  await materialize(expressAdapter.generate(blog, { projectName: "blog" }), dir);
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
  if (install.status !== 0) process.exit(1);
  const push = spawnSync("npm", ["run", "db:push", "--", "--force"], { cwd: dir, stdio: "inherit" });
  if (push.status !== 0) process.exit(1);
  proc = spawn("npm", ["start"], { cwd: dir, stdio: "inherit", env: { ...process.env, PORT: "3210" } });
  await sleep(4000);
  const base = "http://127.0.0.1:3210/api/articles";
  const created = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "hello" }) });
  if (created.status !== 201) { console.error(`POST ${created.status}`); process.exit(1); }
  const { id } = (await created.json()) as { id: number };
  const got = await fetch(`${base}/${id}`);
  const body = (await got.json()) as { title?: string };
  if (got.status !== 200 || body.title !== "hello") { console.error("GET round-trip failed"); process.exit(1); }
  const del = await fetch(`${base}/${id}`, { method: "DELETE" });
  if (del.status !== 204) { console.error(`DELETE ${del.status}`); process.exit(1); }
  console.log("EXPRESS BOOT SMOKE PASS");
} finally {
  proc?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Package script** — add to `packages/adapter-express/package.json` `scripts`: `"smoke": "tsx scripts/boot-smoke.ts"`. Add `tsx` devDep if absent (`pnpm --filter @camis/adapter-express add -D tsx`).

- [ ] **Step 3: Gated workflow** `.github/workflows/adapter-express-boot.yml`
```yaml
name: adapter-express-boot
on:
  workflow_dispatch:
  pull_request:
  schedule:
    - cron: "0 7 * * *"
jobs:
  boot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: ".nvmrc"
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @camis/adapter-express smoke
```

- [ ] **Step 4: Full sweep** — run, report counts: `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`. All green. (Gated workflow not run locally.)

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-express/scripts packages/adapter-express/package.json .github/workflows/adapter-express-boot.yml pnpm-lock.yaml
git commit -m "ci(adapter-express): boot smoke + gated CRUD round-trip workflow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** D1 full skeleton (Task 6) · D2 TS+tsx (Task 6 package.json) · D3 sqlite (Tasks 3–4) · D4 no migrations / drizzle-kit push (Tasks 6,9) · D5 REST CRUD (Task 5) · D6 generate(IrBundle) ignores roles (Task 7) · D7 scalar subset + gap (Tasks 3,7). Exit criteria: Article golden + idempotent (Task 8); gated boot CRUD round-trip (Task 9); lint/typecheck/test (Task 9).

**Placeholder scan:** none — concrete code/commands throughout. Goldens generated via `-u` then inspected (Task 8). The sync better-sqlite3 `.all()/.get()/.run()` decision is explicit. Task 7's note instructs filtering non-subset fields out of the schema/route column lists (importing `isSupported8A`) — fold that filter into the Task 4/5 emitters when implementing Task 7 (the Article golden fixture has only supported fields, so its goldens are unaffected).

**Type consistency:** `expressNames`/`snakeColumn` (Task 2) → fields/schema/routes/skeleton. `emitColumn`/`ColumnEmit`/`isSupported8A` (Task 3) → schema (4), generate (7). `emitSchema` (4), `emitRoutes` (5), `skeletonFiles(doc, projectName)` (6) → `expressAdapter` (7). `expressAdapter`/`blog` → goldens (8), boot-smoke (9). `withMarker`/`buildManifest`/`materialize`/`GeneratedFile`/`GenerationResult` from `@camis/adapter-kernel`; `IrBundle` from `@camis/permissions`; `normalize` from `@camis/ir-core`.

**Risk note:** the emitted Drizzle/Express runtime correctness (sync better-sqlite3 calls, `drizzle-kit push`, the server boot, the CRUD round-trip) is validated only by the gated `adapter-express-boot` job; per-commit tests prove the emitted STRUCTURE + idempotency. If the gated job reveals a Drizzle API mismatch (e.g. `.returning().get()` shape), fix the emitter + regenerate goldens.
