# camis — Build Plan

Sequenced, TDD-first build plan for the separate Claude Code session. Read
[`ARCHITECTURE.md`](./ARCHITECTURE.md) and the root [`CLAUDE.md`](../CLAUDE.md) first.

**Guiding rule:** ship one *thin, end-to-end vertical slice* before any breadth. Prove the
IR design against the most mature reference (Strapi v5) first, so "is my IR right?" is never
confused with "is my transpiler right?". The hard PHP path comes second, once the IR is
trustworthy.

Each phase lists **exit criteria** — objective, testable conditions. Do not start a phase
until the prior phase's exit criteria are green.

---

## Phase 0 — Workspace foundation

**Goal:** an empty but correct monorepo skeleton with tooling and CI.

- pnpm workspace; `pnpm-workspace.yaml`; `tsconfig.base.json` with strict mode.
- `apps/`, `packages/`, `vendor/`, `docs/` scaffolding.
- Toolchain: TypeScript (strict), Vitest (or Jest) for unit/golden tests, ESLint + Prettier,
  a commit hook running lint + test.
- CI pipeline: install → lint → typecheck → test, on every package.
- Empty package stubs with `package.json` + `tsconfig.json` for each library in
  ARCHITECTURE §2.

**Exit criteria:** `pnpm -r test` runs (zero tests is fine), `pnpm -r typecheck` passes,
CI is green on a trivial commit.

---

## Phase 1 — IR schema & validator (`ir-schema`, `ir-core`)

**Goal:** the neutral content model exists, is typed, and validates.

- TDD the IR types: content types, fields (full taxonomy), components, relations, options.
- A JSON Schema (or Zod/Valibot schema) that validates an IR document; invalid documents
  produce precise, located errors.
- `ir-core`: construction helpers, normalization, invariant checks (e.g. relation targets
  resolve, no duplicate field names, dynamic-zone components exist).
- Capability-descriptor type (per-target) and the capability-gap report type.
- **No expressions, no permissions yet** — pure declarative data.

**Exit criteria:** can construct a valid multi-type IR (with a relation and a component) in
tests; malformed IR fixtures each fail with the expected error; ≥1 invariant test per
invariant.

---

## Phase 2 — First vertical slice: Strapi adapter, one content type (`adapter-kernel`, `adapter-strapi`)

**Goal:** IR → a runnable Strapi v5 project for a single `Article` collection type.

- `adapter-kernel`: the generate-adapter contract, the marker/manifest system, generated-vs-
  protected region rules, codegen utilities (deterministic file emission).
- `adapter-strapi` (generate): emit Strapi v5 `schema.json` (correct attribute shapes,
  relation UID format, options) plus the minimal project scaffolding to boot.
- Golden-file tests: `Article` IR fixture → exact expected `schema.json`.
- Smoke test: generated project installs and boots; the content type appears.

**Exit criteria:** from an `Article` IR fixture, `camis generate --target strapi` produces a
project that boots and exposes the type; golden files match byte-for-byte; regen is
idempotent (second run produces no diff).

---

## Phase 3 — Strapi import (declarative round-trip)

**Goal:** Strapi `schema.json` → IR, proving target→IR→target.

- `adapter-strapi` (import): parse a Strapi `schema.json` into validated IR.
- Round-trip property test: `import(generate(ir))` ≅ `ir` (normalized equality) for the
  supported feature subset.

**Exit criteria:** round-trip test green for content types, fields, relations, components;
unsupported constructs are reported, not silently dropped.

---

## Phase 4 — Ring 1 expression layer (`expr`, `expr-ts`, `expr-php-emit`)

**Goal:** one grammar, two semantically-identical outputs, locked by conformance vectors.

- `expr`: grammar, AST, **written semantics spec**, and the canonical **test-vector file**
  (`expression + data → expected output`). Cover truthiness, null, numeric coercion, the
  pure-function catalog, and every operator.
- `expr-ts`: TS runtime evaluator **and** TS emitter; runs all vectors.
- `expr-php-emit`: emits PHP source for an expression; emitted PHP runs all vectors (requires
  PHP in CI for this package's test job).
- Wire expressions into the IR: validation rules, conditional visibility, computed fields
  (declarative attachment points only — no target wiring yet).

**Exit criteria:** 100% of conformance vectors pass in **both** the TS evaluator and the
emitted PHP; a deliberately divergent change to one runtime fails CI; purity/totality guard
rejects a loop/side-effect test case.

---

## Phase 5 — Permissions (`permissions`) + Strapi permission emission

**Goal:** the superset permission model and its first down-projection.

- `permissions`: neutral model (roles → per-type actions → optional field rules → optional
  condition rules), built on Ring-1 predicates.
- Strapi adapter: emit roles/permissions including field-level and condition rules natively.
- Capability-gap report wired in.

**Exit criteria:** an IR with a role carrying a field-level rule and a condition rule
generates correct Strapi permissions; gap report is empty for Strapi on this fixture.

---

## Phase 6 — Second target: Laravel 12 + Filament (`adapter-filament`)

**Goal:** prove the cross-language path end-to-end — the project's hardest, highest-value slice.

- Generate a Laravel 12 + Filament app: content types → Filament Resources; fields → Filament
  form/table schema; relations → Eloquent relationships + migrations.
- Database: Laravel's DB abstraction; env-driven `sqlite | mysql | pgsql` with **no code
  change** between environments. Verify all three in tests/CI.
- Permissions: compile to **`spatie/laravel-permission`** (roles + permission keys) **plus**
  generated **Laravel Policies** whose method bodies come from Ring-1 → PHP (field-level &
  condition rules). **Shield is optional** admin sugar, emitted behind a flag — never the
  compile target.
- Composer owned inside the app; pnpm script wrappers (`pnpm --filter <app> run …`).
- Golden tests for emitted PHP; smoke test that the app migrates and boots on each DB.

**Exit criteria:** `Article` IR + a role with a condition rule generates a Filament app that
boots on sqlite/mysql/pgsql, enforces the Spatie permissions, and enforces the condition via
a generated Policy whose logic matches the Ring-1 conformance result; capability-gap report
flags anything Spatie can't express.

---

## Phase 7 — Ring 2 hook contract

**Goal:** the typed escape hatch for real behavior, in both languages.

- Define named hook/extension points in the IR (typed input/output shapes).
- Adapters emit the typed contract surface (PHP interface / TS type) into a **protected**
  directory and register invocation sites in generated regions.
- Reference hook implemented by hand in both a Strapi and a Filament app to prove the contract.

**Exit criteria:** a sample hook (e.g. "on publish, transform a field") compiles its contract
into both targets; hand-written implementations run; regen preserves the protected
implementation untouched.

---

## Phase 8 — Third target: Express + Drizzle + React admin (`adapter-express`)

**Goal:** validate IR neutrality against a from-scratch, no-framework target.

- Generate Express + Drizzle schema/migrations + a React admin dashboard from the IR.
- Reuse `expr-ts` directly for Ring-1 logic (same-language, no emission needed).
- Permissions down-projected to this target's model; gap report wired.

**Exit criteria:** `Article` IR generates a booting Express+Drizzle API + React admin on
each DB; round-trip and permission tests green; gaps reported.

---

## Phase 9 — AI layers (`ai-authoring`, `ai-runtime-spec`)

**Goal:** AI as a validated IR producer (authoring) and a native IR primitive (runtime).

- `ai-authoring`: NL → IR mutations validated against `ir-schema`; invalid proposals are
  rejected/repaired, never written. (Uses the Anthropic API; keys handled by the environment,
  never embedded.)
- `ai-runtime-spec`: neutral "AI field" / "AI action" IR primitives; each existing adapter
  emits target-specific wiring.

**Exit criteria:** an NL prompt produces a valid IR mutation that round-trips through
validation; an IR with an AI field generates working wiring in ≥2 targets.

---

## Phase 10 — CLI & DX polish (`cli`)

**Goal:** one ergonomic entry point.

- `camis validate | import | generate | build`, target selection via JSON config.
- JSON project config drives "which target(s) to build" per ARCHITECTURE §1.1.
- Clear capability-gap output; helpful errors.

**Exit criteria:** a single JSON config builds a chosen target end-to-end via the CLI; docs
updated; full `pnpm -r test` green.

---

## Phase 11 — Built-in user content type

**Goal:** relations to a target's native user model are representable in the IR.

- IR: optional `builtin: "user"` marker on a content type.
- Strapi import: `plugin::users-permissions.user` relation targets map to a synthesized
  builtin `User` type; other `plugin::` targets become downgrade gaps, not dangling names.
- Strapi generate: round-trips the marker (emits the plugin UID, no schema files for it).
- Filament: builtin user maps to the stock `App\Models\User` / `users` table; no files emitted.
- Express: no change — materializing the builtin as a regular `users` table is correct there.

**Exit criteria:** a real Strapi project with owner/creator relations to the plugin user
(e.g. OYL) imports cleanly and generates on all three targets; round-trip test green.

## Phase 12 — Component fields on relational targets (Filament, Express)

**Goal:** `component` fields stop being capability gaps on the relational targets.

- Non-repeatable component → prefixed embedded columns on the parent table (recursive).
- Repeatable component (any depth) → child table + FK + relation + Filament `Repeater` /
  Drizzle relations.
- Relations inside components remain downgrade gaps (bounded scope).

**Exit criteria:** OYL's `finance.money`, `nutrition.nutrition-facts` (nested + repeatable
`additional`), and `activity.quantity` fixtures generate on both targets; goldens + idempotent
regen; zero component gaps for the OYL corpus.

## Phase 13 — Roles reach the CLI; ownership predicates

**Goal:** `camis build` can emit permission code; record-ownership rules are expressible.

- Project config gains optional `roles` path (validated via `validateBundle`); CLI passes
  roles through instead of hardcoding `[]`.
- Policy/enforce record data exposes relation FKs (`record.<name>Id`) so Ring-1 conditions
  can express `record.ownerId == user.id` on both PHP and Express backends.

**Exit criteria:** a roles file + config produces Spatie seeder, policies, and Express
enforcement via the CLI; denied-path tests cover an ownership condition on both targets.

## Phase 14 — Scaffold & deploy ergonomics

**Goal:** one command from IR to a deployable Laravel app.

- `camis scaffold filament <dir>`: composer create-project + filament install + Spatie
  install + `HasRoles` patch, then overlay (testable via an injected exec).
- Filament target emits `.env.example` + `DEPLOY.md` (shared-hosting path documented).
- CLI bin runs under plain `node` via a tsx-registering wrapper.

**Exit criteria:** scaffold + build + migrate boots a Filament panel from a fresh checkout;
CLI invocable without pnpm dlx.

## Phase 15 — Laravel sync API

**Goal:** the Filament target can serve as a headless backend, not only an admin panel.

- Generated JSON API: routes + controllers per content type (index/show/store/update/destroy).
- IR `options.upsertBy: <uniqueField>` → store() upserts on that field.
- Protected seam: generated `routes/api.php` requires a seed-mode `routes/api-custom.php`
  for bespoke endpoints (e.g. an OYL `/api/bootstrap`).

**Exit criteria:** generated API passes a CRUD + upsert round-trip test; custom-route seam
survives regeneration; policies enforced on API paths when roles are configured.

## Phase 16 — Strapi-compatible API style (`adapter-filament`, `cli`, `permissions`)

**Goal:** a generated Laravel app can replace a Strapi backend for an existing Strapi client
without any per-content-type hand code. Driver: OYL's `apps/camis-php-oyl`; design spec in
the oyl repo at `docs/superpowers/specs/2026-09-08-camis-php-oyl-design.md`.

- Filament target option `apiStyle: "strapi"` (default `laravel` keeps current output
  byte-identical): `{ data }` envelope, Strapi error shape, camelCase serializers that
  re-nest components (inverse of Phase 12 flattening), nulls omitted, numeric casts.
- Route key = `options.upsertBy`; `PUT /:key` upserts within scope, 404 across owners.
  `camis import strapi --upsert-by <field>` sets it on every type with that unique field.
- Route paths are kebab-case `names.plural` (`/activity-sessions`), not table names.
- Controllers emitted as generated base + seed-mode subclass (`Api\Generated\X` /
  `Api\X`) so request-level overrides survive regeneration.
- Ring 1 → Eloquent `where` emitter for the `eq/and/or` subset (`ne`/`not` excluded: SQL
  three-valued logic diverges from Ring 1 on NULL columns), joined to the conformance suite
  (evaluator vs SQL against SQLite); out-of-subset predicates fall back to fetch-then-filter
  and report a downgrade gap. Lists query through the scope.
- Grants gain explicit `assign: { <relation>: "user.id" }` for create-time FK fill; roles
  file gains top-level `defaultRole`.
- Sanctum auth routes mirroring Strapi (`/auth/local`, `/auth/local/register`, `/users/me`),
  `username` column migration, `/api/_health` (under Laravel's API prefix; e2e polls it).
- Project config `protected: <dir>` mirrored into `out` after generation.

**Exit criteria:** OYL fixture generates with zero error gaps; PHP round-trip test
(register → login → CRUD/upsert → cross-owner 404) green; existing goldens unchanged when
`apiStyle` is absent.

## Phase 17 — Strapi storage layout (`ir-schema`, `adapter-strapi` import, `adapter-filament`, `cli`)

**Goal:** a strapi-style generated Laravel app can run on the database a Strapi 5 app created and
still uses, so both backends are interchangeable at the storage and session level, not just the
wire protocol. Driver: OYL; spec in the oyl repo at
`docs/superpowers/specs/2026-09-08-strapi-storage-layout-design.md`.

- IR: `Component.names?: { collection, group }`, filled by the Strapi importer from the component
  file's `collectionName` and folder; adapters derive Strapi's `component_type` from it.
- Filament target option `storageLayout: "strapi"` (requires `apiStyle: "strapi"`): models map
  onto Strapi's tables — owning relations through `_lnk` tables (with `_ord` only when the IR
  relation has an inverse), components through `_cmps` links and component tables (nested and
  repeatable), `document_id` (cuid2) + `published_at` on create, a `StrapiDateTime` cast
  (millisecond integers on sqlite, native timestamps elsewhere), uniqueness enforced in code
  (Strapi has no unique indexes), and the owned `User` model on `up_users` with roles read from
  `up_users_role_lnk`.
- Auth: Strapi-compatible HS256 JWTs (`{ id }`, 30d, shared `JWT_SECRET`) replace Sanctum;
  register/login mirror Strapi's `provider`/`confirmed`/`blocked` semantics and 400 messages.
- Emission: no content migrations, no Filament resources, no Spatie (downgrade gaps); a
  regenerated `camis:strapi-schema-check` artisan command; scaffold `--storage strapi`.
- Ring 1 → SQL: `record.<relation>Id == user.id` renders as `whereExists` on the link table.

**Exit criteria:** existing goldens byte-identical without the option, with two deliberate
exceptions — the cross-check found the Phase 16 wire forms diverging from Strapi's, and both were
corrected rather than papered over: a datetime is now `toIso8601ZuluString('millisecond')`
(`2026-09-08T10:00:00.000Z`, as Strapi and JavaScript send it) where Carbon's `toJSON()` emitted six
fractional digits, and a `bigInteger` is now a JSON string (`"1250"`) where it was a JSON number.
Both apply to `apiStyle: "strapi"` on either storage layout, so an existing Phase 16 deployment sees
a wire-contract change; every other golden is byte-identical. A gated CI job generates a Strapi
project from a fixture IR (with nested + repeatable components), boots it to create a SQLite
database, writes rows and mints a token through Strapi, then boots the PHP app on the same file and
proves reads/writes and tokens interoperate in both directions. This job
(`strapi-storage-crosscheck`, `pnpm --filter @camis/cli crosscheck`) is the phase gate; it passed
locally on 2026-09-09 (`CROSSCHECK OK`). The CI workflow has not yet run on GitHub — nothing has
been pushed.

## Phase 18 — New-project generator (`cli`, `adapter-strapi` import)

**Goal:** one command creates a camis project from scratch, the way `create-strapi-app` creates a
Strapi project, so a team never has to hand-write the first IR and config.

- `camis new <dir>`: writes `camis.json`, `roles.json` (Strapi's `public` + `authenticated`,
  `authenticated` the default), `camis.config.json` (targets under `generated/<target>`, named
  after the directory), `protected/`, `.gitignore`, README; scaffolds a filament host app; builds.
- Content from a template (`vanilla` empty, `example` = create-strapi-app's blog minus its
  dynamic zones) or `--from-strapi <dir>` via the existing declarative importer.
- Importer fixes found by importing upstream's own example: media `allowedTypes` map between
  Strapi's plural kinds and the IR's singular in both directions, and `camis import` prints the
  attributes it drops instead of discarding them silently.

**Exit criteria:** `camis new blog --template example --targets strapi,express` writes a project
whose IR and roles validate together and builds both targets; a second `camis build` inside the
project regenerates byte-identical output; the generated Strapi schema carries Strapi's plural media
kinds, and the importer maps them back to the IR's.

---

## Sequencing rationale (quick reference)

1. **Strapi first** — mature schema validates the IR fastest, with the thinnest adapter.
2. **Import + round-trip early** — locks the IR's neutrality before targets multiply.
3. **Ring 1 before second target** — the cross-language contract must exist before the PHP
   adapter needs it.
4. **Filament second** — highest value, hardest path; do it once Ring 1 is trustworthy.
5. **Ring 2, Express, AI, CLI** — breadth and polish, each resting on a proven core.

## Definition of done (per package)

- Tests written first; red→green→refactor visible in history.
- Public API documented; no `any` leaks across package boundaries.
- One responsibility; no sibling-adapter imports.
- Golden/conformance tests where codegen or cross-language behavior is involved.
