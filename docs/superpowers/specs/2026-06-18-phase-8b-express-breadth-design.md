# Phase 8B — Express/Drizzle Breadth + Relations + Multi-Dialect + Round-Trip Design

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 8, sub-phase B (of A/B/C)
**Scope:** extend `@camis/adapter-express` (built in 8A) to the **full IR field taxonomy**, to
**relations** (Drizzle foreign keys + `relations()` declarations), to **multi-dialect** emission
(`sqlite | mysql | pgsql` via a generation-time `dialect` option), and to a **round-trip** import
from a neutral declarative artifact. Components/dynamicZone are capability-gaps. The React admin,
permissions, and Ring-1 are 8C.

---

## 1. Context & goal

8A proved camis can generate a booting from-scratch Express + Drizzle (sqlite) API for one content
type. 8B adds the breadth that makes the target useful and completes the Phase 8 data-layer exit
criteria: every field type, the relational model, all three databases, and round-trip. The work is
**purely additive** — 8A's `Article` sqlite goldens stay byte-identical where unchanged; 8B adds
richer fixtures and per-dialect coverage. The backbone is **dialect-parameterization**: breadth and
multi-dialect fuse into one `(dialect, fieldType)` column map rather than three separate emitters.

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Multi-dialect via a per-dialect adapter**: `generate()` emits a SINGLE-dialect project. The gated boot runs the generator 3× (one per dialect) and boots each. | Drizzle schemas are dialect-bound (`sqlite-core`/`pg-core`/`mysql-core`); one project per dialect matches Drizzle's design. A runtime env-switch would need a dialect-abstraction layer fighting Drizzle. |
| D2 | **A factory `expressAdapterFor(dialect): GenerateAdapter`** binds the dialect at adapter construction (closure), threaded through the emitters. `expressAdapter = expressAdapterFor("sqlite")` is the default export (back-compatible with 8A). The kernel `GenerateOptions` is UNCHANGED. | The Prime Directive forbids target-specific concepts (a Drizzle/SQL `dialect`) leaking into the shared `adapter-kernel` (`GenerateOptions`). A construction-time factory keeps the dialect entirely inside `adapter-express`; the generic `GenerateAdapter` contract is untouched. The gated boot calls `expressAdapterFor(d)` per dialect. |
| D3 | **Dialect-parameterized column map**: `column(dialect, field)` keyed by `(dialect, fieldType)`, covering the full taxonomy. | Breadth + multi-dialect as ONE table; avoids three near-duplicate emitters. |
| D4 | **Relations → Drizzle FK columns (`.references`) + `relations()` declarations**, mirroring the Strapi/Filament resolution (owner FK for manyToOne/oneToOne, target FK for oneToMany, junction table for manyToMany). Relation *traversal/nesting in the API* is deferred. | The schema-level relational model is the 8B deliverable; nested-resource routes are a later enhancement. |
| D5 | **Round-trip via a neutral `camis.schema.json`** artifact: `generate()` emits the normalized IR document as `camis.schema.json` (`stableJson`); `importExpressProject(files)` reads it back through `ir-schema`. Property: `normalize(import(generate(ir).camisSchema)) ≅ normalize(ir)`. | Respects the Prime Directive (import a declarative artifact, never parse the generated Drizzle TS); runs per-commit (pure, no DB); validates the import path + artifact fidelity. |
| D6 | **Components + dynamicZone → capability-gap** (`downgrade`), excluded from columns. | No native Drizzle analog; consistent with the Filament target; not in the data-layer exit criteria. |
| D7 | **Full goldens for sqlite only; pg/mysql covered by `dialect.ts` + `column()` unit tests + the gated boot.** | Avoids 3× golden bloat; the per-dialect specifics are small and unit-testable; the 3-DB boot is the integration oracle. |

## 3. Multi-dialect mechanism (`dialect.ts`)

`DialectSpec` per dialect captures:
- **core import** (`drizzle-orm/sqlite-core` / `pg-core` / `mysql-core`) and **table fn**
  (`sqliteTable` / `pgTable` / `mysqlTable`).
- **id column** (`integer("id").primaryKey({ autoIncrement: true })` / `serial("id").primaryKey()` /
  `int("id").primaryKey().autoincrement()`).
- **driver** dep + **client** (`drizzle(new Database(...))` better-sqlite3 / `drizzle(postgres(...))` /
  `drizzle(mysql2 pool)`), and the **`drizzle.config` dialect** + `dbCredentials`.
- **timestamp default** for `createdAt`/`updatedAt`.

`expressAdapterFor(dialect)` captures the spec at construction and threads it through the schema,
client, drizzle.config, and package.json emitters. `expressAdapter` (the default export) is
`expressAdapterFor("sqlite")`. No dialect flows through `GenerateOptions`.

## 4. Full field taxonomy (`fields.ts` → `column(dialect, field)`)

One map keyed by `(dialect, fieldType)`. Representative mappings (sqlite / pg / mysql):
- `string`/`email`/`uid`: `text` / `varchar({ length: 255 })` or `text` / `varchar({ length: 255 })`.
- `text`/`richText`: `text` / `text` / `text`.
- `integer`: `integer` / `integer` / `int`. `bigInteger`: `integer` / `bigint` / `bigint`.
- `float`: `real` / `real` / `float`. `decimal`: `numeric` / `numeric` / `decimal`.
- `boolean`: `integer({ mode: 'boolean' })` / `boolean` / `boolean`.
- `enumeration`: `text` / `text` / `text` (portable; pg-enum deferred). `json`: `text({ mode: 'json' })` / `jsonb` / `json`.
- `date`/`time`/`dateTime`/`timestamp`: the dialect's temporal column (`integer timestamp` for sqlite;
  `timestamp`/`date`/`time` for pg/mysql). `media`: `text` everywhere.
Modifiers `notNull`/`unique`/`default` (string defaults escaped, per the 8A security fix) apply across
dialects. Exact per-dialect column expressions are pinned in the plan and validated by the gated boot.

## 5. Relations (`relations.ts`)

`resolveRelations(doc, dialect)` → per content type: owner FK columns (dialect-typed,
`.references(() => target.id)`), synthesized inverse FK columns (oneToMany on the target), junction
tables (manyToMany), and `relations()` declaration blocks. FK naming/dual rules mirror the
Strapi/Filament adapters. The schema emitter appends FK columns + `relations()` blocks; the route
emitter treats FK columns as ordinary insertable columns.

## 6. Round-trip (`import.ts`)

- `generate()` emits `camis.schema.json` = `stableJson(normalize(ir.document))`.
- `importExpressProject(files): { document: Result<IrDocument> }` selects `camis.schema.json` from the
  file set, `JSON.parse`s it, and validates via `ir-schema`'s `parseDocument` (or `irDocument.safeParse`).
- Round-trip test: `normalize(import(generate(ir).files).document.value)` deep-equals `normalize(ir.document)`.

## 7. Generate orchestration

`generate(ir, options)` (the dialect already bound via `expressAdapterFor`): resolve relations; emit the skeleton (dialect-aware
package.json/client/drizzle.config), the schema (id + columns + FK + relations()), the routes, the
server/index, `camis.schema.json`, and `.env`. Route each field: supported scalar → column;
`relation` → the relations pass; `component`/`dynamicZone` → a `downgrade` gap.

## 8. Verification

- **Golden (sqlite):** schema (with relations + full-taxonomy columns), routes, server, client,
  package.json, `camis.schema.json`, file-listing — byte-exact for a relation-bearing fixture; idempotent.
- **Per-dialect unit tests:** `dialect.ts` specs; `column(dialect, field)` for each dialect's distinct
  column expressions (the pg/mysql differences not covered by the sqlite golden).
- **Round-trip test** (per-commit): §6 property on a relation + full-type fixture; gaps empty for the
  round-trippable subset; a component fixture → a gap.
- **Gated boot** (`adapter-express-boot.yml`, `dialect: [sqlite, mysql, pgsql]` matrix + mysql/pgsql
  service containers): per dialect → generate → npm install → `drizzle-kit push` → boot → CRUD
  round-trip including a relation FK.
- **8A regression:** the `Article` sqlite goldens (no relations, default dialect) stay byte-identical.

## 9. Exit criteria (8B)

- Full field taxonomy + all four relation kinds generate a golden-locked, idempotent sqlite project.
- The `dialect` option produces valid pg/mysql schemas (unit-tested + gated-boot-validated on all 3 DBs).
- Round-trip (`import(generate(ir).camisSchema) ≅ ir`) green; components/dynamicZone reported as gaps.
- 8A `Article` sqlite goldens byte-identical; `pnpm lint` / `pnpm -r typecheck` / `pnpm -r test` green.

## 10. Cross-cutting

- The IR is the single source of truth; all Drizzle/Express/SQL specifics confined to `adapter-express`.
- One-way authoritative generation; round-trip imports the declarative `camis.schema.json`, never the
  generated Drizzle TS (Prime Directive).
- Determinism: dialect-deterministic emission, stable ordering, escaped string defaults, no timestamps
  — so goldens and idempotent regen hold.
- Multi-dialect portability is a first-class constraint: every emitted column type must migrate +
  boot on its dialect — validated by the 3-DB gated matrix.
