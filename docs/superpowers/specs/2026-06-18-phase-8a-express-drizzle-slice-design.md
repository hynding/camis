# Phase 8A — Express + Drizzle API Vertical Slice (`adapter-express`) Design

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 8, sub-phase A (of A/B/C)
**Scope:** generate a fully self-generated, bootable TypeScript Node project from the IR for ONE
content type (`Article`, scalar fields) — a Drizzle **sqlite** schema, an Express **REST CRUD**
API, and the complete project skeleton. sqlite only; the multi-dialect matrix and breadth land in
8B. Verification: golden + structural per commit, and a gated CI boot job that installs, pushes the
schema, boots the API, and round-trips a CRUD request.

---

## 1. Context & goal

Phase 8 validates IR neutrality against a **from-scratch, no-framework** target (Express + Drizzle +
a React admin) — decomposed A/B/C. 8A de-risks the hardest unknown first: *can camis generate a
booting from-scratch API?* Unlike Filament (which overlays an official scaffold) and like Strapi
Phase 2, there is no framework installer here, so the generator emits the ENTIRE bootable tree. The
generated app runs on Node/TS — the same runtime as `expr-ts` — so 8C will reuse Ring-1 directly with
no PHP-style emission. 8A is pure content → Express/Drizzle emission; permissions, relations, full
taxonomy, multi-dialect, the React admin, and Ring-1 are later sub-phases.

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Full self-generated skeleton** (the generator owns every file). | No framework installer exists for a from-scratch Express+Drizzle app; mirrors the Strapi Phase 2 `skeletonFiles` model. |
| D2 | **TypeScript + `tsx`** for the generated server (ESM). | No build step for the dev server; matches the monorepo's ESM/TS ethos; the app shares the Node/TS runtime with `expr-ts` (relevant in 8C). |
| D3 | **sqlite only in 8A.** | Drizzle schemas are dialect-specific (`sqliteTable`/`pgTable`/`mysqlTable`); the per-dialect emission + selection mechanism is designed in 8B. 8A targets the simplest boot to de-risk the scaffold. |
| D4 | **Drizzle migrations are NOT emitted; the gated boot runs `drizzle-kit push`.** | drizzle-kit migration files carry hashes/ordering that are non-deterministic and ungoldenable. Emitting the deterministic SCHEMA and applying it via `push` keeps goldens stable while still creating the tables. |
| D5 | **REST CRUD per content type** (`GET /` list, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`). | The conventional, minimal API surface; enough to prove the boot + round-trip. |
| D6 | **`generate(ir: IrBundle)` reads `ir.document`, ignores `ir.roles`.** | Permissions are 8C; 8A honors the kernel contract without emitting auth. |
| D7 | **8A content surface = a representative scalar subset** (string, text, boolean, integer, dateTime); one mapping table feeds the schema columns. | Full taxonomy + relations are 8B; keep the slice minimal. |

## 3. Packages & dependency direction

- **`@camis/adapter-express`** (fills the stub) — a `GenerateAdapter`. Deps: `adapter-kernel`
  (`GenerateAdapter`/`GeneratedFile`/`GenerationResult`/`buildManifest`/`withMarker`), `ir-schema`
  (types), `ir-core` (`normalize`), `permissions` (the `IrBundle` type). NOT `expr-ts` yet (8C). No
  sibling-adapter import; all Express/Drizzle specifics confined here.
- ESLint adapter boundary already permits `adapter-express → kernel/ir-schema/ir-core/permissions`.

## 4. Emitted file set (a complete bootable tree, for `Article`)

`generate(ir, { projectName })` → all files (`mode: "overwrite"` unless noted):
1. **`package.json`** — deps `express`, `drizzle-orm`, `better-sqlite3`, `drizzle-kit`, `tsx`,
   `typescript`, `@types/express`, `@types/better-sqlite3`, `@types/node`; scripts
   `{ "dev": "tsx watch src/index.ts", "start": "tsx src/index.ts", "db:push": "drizzle-kit push" }`.
2. **`tsconfig.json`** (NodeNext/ESNext, strict), **`.env`** (`mode: "seed"`; `DB_FILE_NAME=./data.db`,
   `PORT=3000`), **`drizzle.config.ts`** (`defineConfig({ out: './drizzle', schema: './src/db/schema.ts', dialect: 'sqlite', dbCredentials: { url: process.env.DB_FILE_NAME! } })`).
3. **`src/db/schema.ts`** — `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";`
   then `export const articles = sqliteTable('articles', { id: integer('id').primaryKey({ autoIncrement: true }), <columns>, createdAt: integer('created_at', { mode: 'timestamp' }), updatedAt: integer('updated_at', { mode: 'timestamp' }) });`
4. **`src/db/client.ts`** — `import Database from "better-sqlite3"; import { drizzle } from "drizzle-orm/better-sqlite3"; import * as schema from "./schema"; export const db = drizzle(new Database(process.env.DB_FILE_NAME ?? "./data.db"), { schema });`
5. **`src/routes/articles.ts`** — an Express `Router` with the five CRUD handlers using
   `db.select().from(articles)`, `db.insert(...).values(...).returning()`, `db.update(...).set(...).where(eq(articles.id, id)).returning()`, `db.delete(...).where(eq(...))`. Column allow-list from the IR fields for the request body.
6. **`src/server.ts`** — `express()` app: `express.json()`, mounts `articlesRouter` at
   `/api/articles`, a JSON 404 + error handler; exports the app.
7. **`src/index.ts`** — imports the app, `app.listen(process.env.PORT ?? 3000)`.

Generated TS files carry the `withMarker` header; `package.json`/`tsconfig.json`/`drizzle.config.ts`
are deterministic JSON/TS without the TS comment marker where it would be invalid (JSON), with the
marker on the `.ts` ones.

## 5. Field → Drizzle sqlite column (8A scalar subset)

A single `fields.ts` map: `string|text|email|uid → text('<col>')`; `integer → integer('<col>')`;
`float → real('<col>')`; `boolean → integer('<col>', { mode: 'boolean' })`; `dateTime → integer('<col>', { mode: 'timestamp' })`. Modifiers: `required` → `.notNull()`; `unique` → `.unique()`;
`default` → `.default(<value>)`. Column names are snake_case of the IR field name. Non-subset field
types in the 8A fixture are out of scope (they arrive in 8B); the emitter records a capability-gap
rather than emitting an unknown column.

## 6. Determinism & migrations

Emitted source is deterministic (fields in IR order, stable imports, no timestamps), so goldens and
idempotent regen hold. Per D4, NO migration files are emitted; the gated boot creates tables with
`drizzle-kit push` (sqlite). `createdAt`/`updatedAt` columns are schema-level defaults, not
application timestamps in the output.

## 7. Verification

- **Golden** (`__golden__/`): each emitted file byte-exact for an `Article` fixture (`schema.ts`,
  `client.ts`, `routes/articles.ts`, `server.ts`, `package.json`, `tsconfig.json`, `drizzle.config.ts`,
  `index.ts`).
- **File-listing golden** + **idempotent regen** (second `generate` deep-equals the first).
- **Mapping unit tests:** each scalar IR field → its Drizzle column fragment.
- **Gated boot** (`.github/workflows/adapter-express-boot.yml`, sqlite only): checkout → setup
  node/pnpm → `pnpm install` → materialize the generated project to a temp dir (a `scripts/boot-smoke.ts`
  tsx script like Strapi's) → `npm install` in the generated dir → `npm run db:push` → start the
  server in the background → `POST /api/articles {title}` (expect 201 + id), `GET /api/articles/:id`
  (expect 200 + the title), `DELETE` (expect 204) → kill the server. Green = the from-scratch app
  boots and the CRUD round-trips. Triggers: `workflow_dispatch` + `pull_request` + nightly.

## 8. Exit criteria (8A)

- `Article` (scalars) generates a complete, well-formed Express + Drizzle (sqlite) project,
  golden-locked and idempotent.
- The gated boot job installs deps, pushes the schema, boots the API, and a CRUD round-trip succeeds.
- `pnpm lint` / `pnpm -r typecheck` / `pnpm -r test` green; per-commit CI green.
- Out of scope (deferred): relations, full field taxonomy, multi-dialect (8B); React admin,
  permissions, Ring-1 (8C).

## 9. Cross-cutting

- The IR is the single source of truth; `adapter-express` is neutral-in / Express+Drizzle-out. All
  Express/Drizzle/sqlite specifics confined to this adapter.
- One-way authoritative generation: IR → project. Round-trip import (from a declarative artifact) is
  8B; nothing parses the generated TS back into IR.
- Determinism (D4/D6): stable ordering, no timestamps, `drizzle-kit push` for tables — so goldens and
  idempotent regen hold.
- The adapter needs no Node server to build or to run its golden tests; only the gated boot job needs
  npm + a running server.
