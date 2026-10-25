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

## Strapi feature parity on the Filament target (Phases 19–30)

**Goal:** a project migrated off strapi-php onto camis's Filament target (`apiStyle: "strapi"`,
laravel storage layout — what `camis new` generates) keeps every Strapi feature strapi-php gives
it, while staying deployable on plain shared hosting. strapi-php is the feature checklist
(its README table and `parity.json`); upstream's `tests/api` suite, as strapi-php runs it, is the
behavioural oracle for the wire format.

**Shared-hosting guardrails (every phase, enforced in review and by the boot CI job):**

- PHP-FPM / LSAPI only: nothing may require a long-running process (no queue worker, no
  websocket server, no Octane/FrankenPHP). Work that Strapi does in the background (webhooks,
  image formats, emails) runs inline or after the response (`dispatchAfterResponse`), with
  `QUEUE_CONNECTION=sync` the supported default.
- Cron is optional: the scheduler (`schedule:run`) may add conveniences, never correctness.
- No Node at deploy or at runtime. Filament's assets are prebuilt; nothing new may add an npm step.
- No PHP extension beyond Laravel's defaults; `gd` is optional (image formats degrade to the
  original file without it, and the gap is reported).
- Per-request cost stays Laravel's: generated code must survive `config:cache`, `route:cache`,
  `view:cache`, `event:cache`, `filament:optimize` and `composer --classmap-authoritative`, and
  runtime helpers are plain classes, not service-provider boot work.
- SQLite is the default database; MySQL and Postgres by env var only.

| Phase | Strapi feature (strapi-php package) | Notes |
| --- | --- | --- |
| 19 | REST query core: `documentId`, `filters`, `sort`, `pagination`, `fields`, `meta`, error envelope (`strapi/utils`, `core-api`) | below |
| 20 | Relations on the wire and `populate` (components, relations, media unpopulated by default, as in Strapi 5); `connect`/`disconnect`/`set` writes | changes today's always-nested components |
| 21 | Draft & Publish: Strapi 5's two-row document model, `status=draft\|published`, publish/unpublish/discard in Filament (`core` document service) | below |
| 22 | Internationalization: IR `localized` content types and fields, `locale` param, locales settings, Filament locale switcher (`strapi/i18n`) | IR change |
| 23 | Media library and Upload API: Strapi's `files` shape, `/api/upload`, formats via GD, local disk default, S3 and Cloudinary through Laravel filesystems (`strapi/upload`) | |
| 24 | Users & Permissions completion: forgot/reset/change password, email confirmation, refresh sessions, OAuth providers, blocked users, roles × actions matrix editor (`plugin-users-permissions`) | |
| 25 | API tokens (read-only, full-access, custom; salted hashes; expiry; `lastUsedAt`) (`strapi/admin`) | transfer tokens move to 29 |
| 26 | Webhooks and lifecycle events (`entry.*`, `media.*`), sent after the response (`strapi/admin`, `core`) | no worker |
| 27 | Dynamic zones on relational targets, plus the importer gaps that block strapi-php projects (snake_case attribute names, morph relations) | see `docs/` import limits |
| 28 | GraphQL (opt-in, `webonyx/graphql-php` like strapi-php; same schema naming as Strapi's plugin) (`plugin-graphql`) | |
| 29 | OpenAPI document + Swagger UI, data export/import archives compatible with Strapi's, and the transfer tokens that guard them (`strapi/openapi`, `plugin-documentation`, `strapi/data-transfer`) | |
| 30 | Strapi-like admin in Filament: Content Manager navigation, Settings area, Strapi wording | Filament stays the admin (owner's call, 2026-10-16); no Strapi React bundle |

Not planned: content-releases, review-workflows, content history, audit logs, preview (Enterprise,
strapi-php does not port them either). The Content-Type Builder stays the camis CLI and AI
authoring: the IR is the source of truth and generation is one-way, so a runtime schema editor
would need Node and codegen on the server.

## Phase 19 — Strapi REST query core (`adapter-filament`, `cli`)

**Goal:** a Strapi 5 client's list and detail requests behave the same against the generated app
as against strapi-php, on the laravel storage layout.

- Every content type gets a `document_id` column (cuid2, 24 chars, unique, filled on create by a
  generated `HasDocumentId` trait, including from Filament), serialized as `documentId`; it is the
  route key unless `options.upsertBy` names another field.
- A generated runtime, `App\Support\StrapiQuery`, ports strapi-php's query semantics: `filters`
  with every attribute operator (`$eq` … `$notContainsi`, `$null`, `$notNull`, `$in`, `$notIn`,
  `$between`, `$not`) and the logical `$and`/`$or`/`$not`, over top-level scalars, embedded
  component scalars and repeatable components (`whereHas`); value casting per field type;
  `sort` (string, list, object forms; default `id` order); `pagination` (page/pageSize and
  start/limit, `withCount`, defaults 25 / no max, `limit=-1`, the mixed-form error); `fields`.
  Unknown keys are 400 `ValidationError`s worded as Strapi's (`Invalid key x`).
- Every response carries `meta` (`{ pagination }` on lists, `{}` otherwise); every error carries
  Strapi's full envelope `{ data: null, error: { status, name, message, details } }`.
- Each serializer exports its wire-key → column map (`FIELDS`), the runtime's only per-type input.

**Exit criteria:** a canonical vector file (query string → expected ids and `meta`) runs against
the booted app in the `strapi-api` boot job and passes; goldens change only where this phase says
(new column, `documentId`, `meta`, error envelope); regeneration is idempotent.

Found while proving the guardrails: `routes/api.php` prepended `StrapiErrors` to the `api` group at
route-file load, which `route:cache` skips, so a cached app 500'd unauthenticated requests.
`camis scaffold` now adds the same line to `bootstrap/app.php`, and the boot job serves the app
with config, route, event and view caches on.

**Status (2026-10-16):** the 72 vector checks pass against strapi-php and against a Laravel 12 +
Filament v5 app (SQLite, all caches on); the existing smoke passes unchanged.

Known gaps left for later phases: the strapi storage layout keeps its own query path (no
`filters`/`sort`/`pagination` yet); nulls are still omitted from the wire (a Phase 16 choice that
diverges from Strapi, revisit with Phase 20); a secured list post-filters each page through the
policy when the read condition has no SQL form, so its `total` can overcount.

---

## Phase 20 — Relations on the wire and `populate` (`adapter-filament`, `cli`)

**Goal:** a Strapi 5 client reads and writes relations and components the same way against the
generated app as against strapi-php, on the laravel storage layout.

- Components and relations are left off the wire unless `populate` names them: `*`, a comma list,
  a list (with dotted nesting, `books.genres`), or an object whose entries take `fields`,
  `filters`, `sort`, a nested `populate` and `count`. Unknown keys are Strapi's 400s.
- Relations appear from both sides (an inverse such as `Author.books` too), as their target's wire
  object; a to-many in id order. Relations to the built-in user stay off the wire.
- A generated runtime, `App\Support\StrapiPopulate`, eager-loads each populated relation once per
  level for the whole page, so a list costs one query per populated relation, not one per row.
- Reads of a target go through its read grant (`viewAny`), its `forUser` scope and its `view`
  policy; a relation the caller cannot read is dropped from `populate`, and is an invalid key in
  `filters` and in a write, as on Strapi.
- `filters` reach relations (`filters[author][name][$eq]`, ids, `$null`/`$notNull`); `sort` takes a
  related field (`author.name:desc`) through a correlated subquery.
- `App\Support\StrapiRelations` takes Strapi's relation input on create and update — a documentId,
  an id, an object holding one, a list, `{ connect, disconnect, set }` — on either side of a
  relation, resolving every reference within the caller's view before writing anything.
- `alwaysPopulateComponents` on a Filament target (or `CAMIS_REST_ALWAYS_POPULATE_COMPONENTS`) keeps
  sending components without `populate`, for clients written against camis before this phase.

**Exit criteria:** `populate-vectors.json`, whose expected outcomes are recorded from strapi-php
(`strapi-populate-vectors.mjs --record`), passes against the booted app in the `strapi-api` boot
job, which now runs on SQLite, MySQL and Postgres; the REST vectors and the smoke still pass.

**Status (2026-10-17):** the 50 populate checks and the 72 REST checks pass against a Laravel 12 +
Filament v5 app on SQLite and Postgres with all caches on. A StrapiError is no longer logged: the
vectors showed every client 400 landing in `laravel.log`.

Known gaps: `connect` positions are accepted but not kept, and to-many relations list in id order
where Strapi keeps link order (the pivot has no order column); `populate` inside a relation ignores
`pagination`; a component nested in a component comes with its parent rather than needing its own
`populate`; relations to the built-in user cannot be populated (no user serializer yet, Phase 24);
the strapi storage layout still always sends components; relation filters and sort trust the
target's `forUser` scope, so a read condition with no SQL form (the Phase 19 overcount gap) can be
probed through them.

## Phase 21 — Draft & Publish (`adapter-filament`)

**Goal:** a `draftPublish` content type behaves over REST as on Strapi 5, and the Filament admin
edits drafts and publishes them, on the laravel storage layout with the Strapi API style.

- Strapi 5's document model: every document has a draft row, which every write goes through, and
  once published a second row with `published_at` set; the two share `document_id` (indexed, no
  longer unique for these types). `App\Support\StrapiDocuments` publishes by copying the draft
  over the published row (columns, repeatable components, the links the type holds), and
  unpublishes, discards and deletes.
- REST: reads show the published version unless `status=draft`; create and update write the draft
  and publish it unless `status=draft`, behind the `publish` grant and inside the same transaction
  (a denied publish writes nothing); delete removes both versions.
- Links: between two versioned types, and from a versioned type to a plain one, each version holds
  its own, and a published version links only to targets that were published when it was (a later
  publish of the target shows on the next publish). A plain type's link to a versioned one holds
  the target's draft and is shown as its published version; a plain target's link to a versioned
  type is reached from the published version through its draft. Relation input names either
  version and links the draft.
- Admin: the resource lists one row per document (its draft) with a Draft / Published / Modified
  badge; the edit page publishes (saving first), unpublishes and discards changes, each behind its
  grant; relation pickers offer drafts.
- Gaps reported, not dropped: the Laravel API style keeps one row per record; `upsertBy` or an own
  `publishedAt` field disables draft and publish for the type; a unique field is not enforced by the
  database (a draft and its published version share the value).
- An `onPublish` hook also runs when a document's published version is first created.

**Exit criteria:** `draft-publish-vectors.json`, recorded from strapi-php, passes in the
`strapi-api` boot job on SQLite, MySQL and Postgres, with `strapi-publish-grant.sh` (the denied
paths) and the admin's `DraftAdminTest`; the populate and REST vectors and the smoke still pass.

**Status (2026-10-17):** the 24 Draft & Publish checks, the 50 populate checks, the 72 REST checks,
the publish-grant checks and the admin test pass on SQLite and Postgres with all caches on.

Known gaps: relation `filters` and `sort` read the stored link, so they do not follow the two
projections above (a plain type filtering on a versioned target matches its draft); unpublish and
discard are admin-only (Strapi's REST API has neither); Modified compares second-resolution
timestamps, so an edit in the same second as the publish reads as Published; a required foreign
key to a versioned type blocks unpublishing a target it links; the strapi storage layout keeps
reporting draft and publish as a gap.

## Phase 22 — Internationalization (`ir-schema`, `adapter-strapi`, `adapter-filament`, `adapter-express`)

**Goal:** a `localized` content type behaves over REST as on Strapi 5 with its i18n plugin, and
the Filament admin lists, edits and translates one locale at a time, on the laravel storage layout
with the Strapi API style.

- IR: `options.localized` on a content type and `localized: false` on a field that every locale
  shares (fields are localized by default, as in Strapi). A field that sets `localized` on a type
  that is not localized is a validation error. The Strapi adapter emits and imports
  `pluginOptions.i18n`; the Express adapter reports it as a gap.
- Each locale of a document is a row sharing `document_id` (indexed, no longer unique), with a
  `locale` column. Locales live in `i18n_locales`, seeded with the configured default
  (`CAMIS_DEFAULT_LOCALE`, `en`), and are listed by `GET /api/i18n/locales`.
- REST: `locale` narrows reads (the default locale when absent, `*` for all of them, an unknown one
  finds nothing); create writes the requested locale; update in a locale the document lacks creates
  it, copying the shared fields but not the links; a shared field written in one locale is written
  to the document's other locales of the same status; delete removes the requested locale (both
  versions when the type also has Draft & Publish). `localizations` populates the other locales.
- Links: a localized source links a localized target in its own locale; a source without locales
  links the target's default locale and shows it whatever locale is read. Draft & Publish works
  per locale.
- Admin: a Locales resource; a localized type's list shows one locale (the default first) with a
  locale filter and badge; the form picks the locale on create; the edit page translates the
  document into a locale it lacks, behind the create grant; relation pickers offer the record's
  locale (the default one for a type without locales).
- Gaps reported, not dropped: the Laravel API style keeps one row per record; `upsertBy`, a unique
  field and a relation marked `localized: false` cannot be honored per document.

**Exit criteria:** `i18n-vectors.json`, recorded from strapi-php, passes in the `strapi-api` boot
job on SQLite, MySQL and Postgres, with the admin's `LocaleAdminTest`; the earlier vectors, the
admin's `DraftAdminTest` and the smoke still pass.

**Status (2026-10-18):** the 26 i18n checks, the 24 Draft & Publish checks, the 50 populate checks,
the 72 REST checks, both admin tests and the smoke pass on SQLite and Postgres with all caches on.

Known gaps: single types are not ported yet, so none is localized; writing to a locale that is
not in `i18n_locales` is accepted, as strapi-php accepts it (Strapi rejects it); relation
`filters` and `sort` on `localizations` match every locale of the document, the row's own included;
the admin's translate action copies every field of the source locale rather than leaving the
localized ones empty; the strapi storage layout is not run against these vectors.

---

## Phase 23 — Media library and Upload API (`ir-schema`, `adapter-strapi`, `adapter-filament`, `adapter-express`)

**Goal:** media fields and Strapi's Upload API behave over REST as on Strapi 5 with its upload
plugin, and the Filament admin keeps a media library, on the laravel storage layout with the Strapi
API style, with nothing more than PHP-FPM and GD on the host.

- IR: `builtin: "file"` declares the media library as a content type with no fields, once per
  project; nothing may relate to it. Its grants authorize the library. The Strapi adapter maps them
  to the upload plugin's admin and Content API actions (a grant's conditions are a gap there); the
  Express adapter reports the builtin as a gap.
- Files live in Strapi's `files` table and link to entries through `files_related_mph`
  (`related_type`, `related_id`, `field`, `order`), so a media field is no column. A project with
  media fields and no declared file type gets an implicit one.
- REST: `POST /api/upload` (multipart `files` + `fileInfo`, or `ref`/`refId`/`field` to link an
  entry), `POST /api/upload?id=` to edit file info, `GET /api/upload/files` with filters, sort and
  fields, `GET` and `DELETE /api/upload/files/:id`, each with Strapi's bodies and errors. Images get
  Strapi's thumbnail, large, medium and small formats through GD; hashes, urls and kB sizes follow
  Strapi. Entries write media by id or documentId, populate them only when asked, and Draft &
  Publish copies the links on publish.
- Storage: `public/uploads` served at `/uploads` by default, as Strapi's local provider; another
  Laravel disk (S3, …) through `CAMIS_UPLOAD_DISK`; `CAMIS_UPLOAD_SIZE_LIMIT` (Strapi's 200 MB).
- Admin: a Media Library resource that uploads, previews and edits file info; forms pick media
  through a select that can upload in place; both behind the file grants.

**Exit criteria:** `media-vectors.json`, recorded from strapi-php, passes in the `strapi-api` boot
job on SQLite, MySQL and Postgres, with the admin's `MediaAdminTest`; the earlier vectors, admin
tests and the smoke still pass.

**Status (2026-10-19):** the 24 media checks, the 26 i18n, 24 Draft & Publish, 50 populate and 72
REST checks, the three admin tests and the smoke pass on SQLite and Postgres with all caches on.

Known gaps: originals are stored as uploaded, not re-encoded as sharp does, and an animated GIF's
formats keep only its first frame; repeated `files` form keys need the `files[]` spelling (PHP keeps
only the last one otherwise); there are no folders; `allowedTypes` is not enforced; `findOne`
ignores `fields` and the file list ignores pagination, as strapi-php does; the admin's picker does
not keep the order of a multiple media field; the Laravel API style keeps media as path columns and
the strapi storage layout is not run against these vectors.

---

## Phase 24 — Users & Permissions, part 1: accounts (`adapter-strapi`, `adapter-filament`)

**Goal:** the account routes of Strapi 5's users-permissions plugin behave over REST as on Strapi,
on the laravel storage layout with the Strapi API style, and the Filament admin manages users and
the plugin's settings. Sessions stay legacy JWTs (Sanctum tokens), Strapi's default.

- The users table gains Strapi's `document_id`, `provider`, `confirmed`, `blocked`,
  `reset_password_token` and `confirmation_token` (accounts made before the migration stay
  confirmed). Users go on the wire as Strapi sanitizes them.
- REST: register and login with Strapi's checks in Strapi's order and its yup messages (closed
  sign-ups, unknown body keys, taken email or username, unconfirmed and blocked accounts);
  `change-password`, `forgot-password`, `reset-password`, `email-confirmation` (a redirect) and
  `send-email-confirmation`, mailing Strapi's templates through Laravel's mailer; a blocked or
  unconfirmed session is refused on every route; `/users` list, count, read, create, update and
  delete behind the builtin user's grants.
- A request without credentials gets Strapi's answer for a public role that is granted nothing,
  403 `ForbiddenError`; a token that does not verify stays a 401.
- Settings: Strapi's advanced settings and email templates have config defaults
  (`CAMIS_ALLOW_REGISTER`, `CAMIS_EMAIL_CONFIRMATION`, …) and a runtime override in
  `strapi_settings`, edited on the admin's Users & Permissions page by whoever may update users.
- Admin: a Users resource (username, email, password, confirmed, blocked, roles) behind the
  builtin user's grants.
- The Strapi adapter maps grants on the builtin user to `plugin::users-permissions.user.*` (it
  emitted `api::user.user.*`, which nothing checks).

**Exit criteria:** `auth-vectors.json`, recorded from strapi-php, passes in the `strapi-api` boot
job on SQLite, MySQL and Postgres, with the admin's `UsersAdminTest`; the earlier vectors, admin
tests and the smoke still pass.

**Status (2026-10-19):** the 60 auth checks, every earlier suite and the smoke pass on SQLite and
Postgres with all caches on; the four admin tests pass.

Known gaps, for part 2: refresh-token sessions (`/auth/refresh`, `logout`, `sessions`), OAuth
providers (`/connect/:provider`), the public role (grants to unauthenticated callers), and `/roles`
and `/permissions`, whose roles live in the IR rather than in an editable matrix. Also: `/users`
ignores pagination and `populate`; a register body takes no extra user fields
(`register.allowedFields`); email senders default to Laravel's `mail.from` rather than Strapi's
no-reply address; the strapi storage layout keeps register, login and `/users/me` only (reported).

---

## Phase 24 — Users & Permissions, part 2: the public role, sessions and roles (`permissions`, `adapter-filament`)

**Goal:** callers without a session get the public role's grants, refresh-token sessions work as
in Strapi 5, and the roles routes answer as Strapi's do, on the laravel storage layout with the
Strapi API style.

- The public role: an IR role named `public` (`PUBLIC_ROLE`) applies to callers without a token.
  Policies and scopes take a nullable user; a guest's condition data has no `user.id`, so a
  condition that needs one fails closed. Strapi's public-only routes (login, register, the
  password and confirmation routes, refresh) refuse a session with 403, and its
  authenticated-only routes refuse a guest. Without a `public` role, guests keep the 403 of part 1;
  on other API styles or the strapi storage layout the role is reported as a `publicRole` gap.
- Sessions: `CAMIS_JWT_MANAGEMENT=refresh` (Strapi's `jwtManagement: 'refresh'`) gives each login
  a session in `strapi_sessions` with a rotating refresh token (only its hash is kept) and a
  Sanctum access token that lasts `CAMIS_ACCESS_TOKEN_LIFESPAN` seconds. `/auth/refresh`,
  `/auth/logout`, `/auth/sessions` and `DELETE /auth/sessions/:id` follow Strapi, including the
  httpOnly cookie mode (`CAMIS_SESSIONS_HTTP_ONLY` or the `x-strapi-refresh-cookie` header) and a
  new session after a password change or reset. `legacy-support` stays the default, where the
  session routes answer 404 as Strapi's do. Expired sessions are swept on about one login in
  fifty, so no scheduler is needed.
- Strapi answers a single read without the read grant with 403 (camis answered 404), and sorting
  by an unreadable relation with 400 `Invalid key`; both now match.
- `/users-permissions/roles[/:id]` and `/users-permissions/permissions` answer 403 to every
  caller: roles live in the IR, so no grant opens them, as none of Strapi's shipped roles does.

**Exit criteria:** the 92 checks of `auth-vectors.json` (legacy mode) and the 37 of
`session-vectors.json` (refresh mode), both recorded from strapi-php, pass in the `strapi-api`
boot job on SQLite, MySQL and Postgres; the earlier vectors, admin tests and the smoke still pass.

**Status (2026-10-19):** every suite passes on SQLite and Postgres with all caches on, and the
admin tests pass.

Known gaps: OAuth providers (`/connect/:provider`) come next. Ending a session revokes its access
tokens at once, where Strapi's stateless JWTs live until they expire (stricter, so no vector
checks it). The Filament admin has no role matrix (Phase 30). Null scalars are left off the wire
where Strapi sends them.

---

## Phase 24 — Users & Permissions, part 3: sign-in providers (`adapter-filament`)

**Goal:** Strapi 5's sign-in providers work as on Strapi, on the laravel storage layout with the
Strapi API style, and the Filament admin turns them on and configures them.

- Settings: Strapi's 17 providers (email and 16 OAuth ones) with its defaults, overridden by what
  the admin saves in `strapi_settings` (`users-permissions.grant`), edited in a Providers section
  of the Users & Permissions page. Turning email off refuses `/auth/local` as Strapi does.
- REST: `/connect/:provider` sends the browser to the provider with a state kept in a Laravel
  session (database driver, no cookie beyond the session's); its callback trades the code for
  tokens, keeps them in the session and returns to the front end, which signs in with
  `/auth/:provider/callback`. A `?callback=` must match the configured page's origin and path.
  The account is the one made through that provider for that email, else a new confirmed one with
  the default role and no password; Strapi's errors and their order are kept.
- OAuth 2 for every provider but Twitter, which runs OAuth 1 (HMAC-SHA1); Cognito's id token is
  verified against the provider's JWKS. Each provider's profile check is ported from strapi-php.
- Provider requests go through Laravel's HTTP client, so a shared host needs nothing beyond
  outbound HTTPS.

**Exit criteria:** the 45 checks of `oauth-vectors.json`, recorded from strapi-php against a
stand-in Keycloak, CAS and Cognito served over HTTPS (`fake-oauth-provider.mjs`), pass in the
`strapi-api` boot job on SQLite, MySQL and Postgres, with `ProvidersTest` (the fixed-host
providers through `Http::fake`, Twitter's OAuth 1 and the admin settings); every earlier suite
still passes.

**Status (2026-10-20):** every suite passes on SQLite and Postgres with all caches on, and the
admin tests pass. Recording the vectors found that strapi-php's `fetch` read every status as 0 on
PHP 8.3, which broke its provider sign-in; that is fixed in strapi-php.

Known gaps: providers registered in code (Strapi's `providers-registry.add`) have no hook here,
and the stand-in provider covers the three providers whose host is a setting; the rest are
checked against recorded answers, not a live provider.


## Phase 25 — API tokens (`adapter-filament`)

**Goal:** Strapi 5's content API tokens work as on Strapi, on the laravel storage layout with the
Strapi API style, and the Filament admin makes and manages them.

- A token is read-only, full-access or custom (a list of Strapi actions, `api::book.book.find`),
  with an optional lifespan of 7, 30 or 90 days. Its 256-hex-character key is kept as an
  HMAC-SHA512 hash salted with `API_TOKEN_SALT` (Strapi's own variable; unset, the app key), and
  encrypted with the app key so the admin can show it again. A use is recorded at most hourly.
- Strapi tries a token before a session on every API route: `StrapiApiToken` checks it against
  the route's action, named as Strapi names it from the controller and method that serve it, and
  refuses an expired one with Strapi's "Token expired". A route Strapi does not have (a
  hand-written one in `api-custom.php`) is open to full-access tokens only.
- A token stands in for a role: it decides every grant the request asks for through one
  `Gate::before`, reads every row (no role condition narrows a list), and acts for no user, so
  `/users/me`, change-password and the session routes answer as Strapi does without an account.
  A type reached through a relation, in populate or a filter, needs that type's find.
- The admin's Settings › API Tokens resource makes, edits, shows, regenerates and deletes tokens,
  for whoever may change accounts (`user.update`).

**Exit criteria:** the 48 checks of `token-vectors.json`, recorded from strapi-php, pass in the
`strapi-api` boot job on SQLite, MySQL and Postgres, with `ApiTokensTest` (the admin page,
lifespans, the hourly last use, rows a role condition hides, refresh-mode sessions); every earlier
suite still passes.

**Status (2026-10-21):** every suite passes on SQLite and Postgres with all caches on, and the
admin tests pass.

Known gaps: transfer tokens belong to data transfer (Phase 29). Strapi's admin tokens (`kind:
admin`) open its admin API, which Filament replaces. A token is refused the users-permissions
role routes, as every session is: the roles are the IR's. The Strapi storage layout accepts no
API token (the Strapi instance keeps them), and tokens are not carried over from a Strapi
database.

## Phase 26 — Webhooks (`adapter-filament`)

**Goal:** Strapi 5's webhooks fire as on Strapi, on the laravel storage layout with the Strapi API
style, without a queue worker, and the Filament admin manages them.

- Webhooks live in Strapi's own `strapi_webhooks` table. Every enabled webhook that hears an event
  is POSTed `{ event, createdAt, ...info }` with its own headers over `camis.webhooks.default_headers`
  (Strapi's `server.webhooks.defaultHeaders`), `X-Strapi-Event` and JSON, with a 10 s timeout; an
  error status or a failure is its answer, never the write's.
- Events: `entry.create`, `entry.update` and `entry.delete` from every content type's writes
  (through the API, the admin or any Eloquent save), `entry.publish`, `entry.unpublish` and
  `entry.draft-discard` from the documents (a version's own copy is not an event), and
  `media.create`, `media.update` and `media.delete` from the media library. An entry is sent
  populated as Strapi's deep populate reads it, whoever wrote it; a deletion or an unpublication
  as the row was. A row written twice in a request is one event, and nothing is sent for a
  transaction that rolls back.
- Shared hosting: events are sent once the response has gone (`app()->terminating`, after
  PHP-FPM's `fastcgi_finish_request`), so no queue worker or cron is needed and a slow receiver
  never slows a write.
- Types without draft and publish carry `publishedAt`, the time of their last write, as Strapi
  stamps it.
- The admin's Settings › Webhooks resource makes, edits, enables, triggers (`trigger-test`) and
  deletes webhooks, refusing a url the public internet cannot reach in production, for whoever may
  change accounts (`user.update`) where the project has roles.

**Exit criteria:** the 30 checks of `webhook-vectors.json`, recorded from strapi-php against a local
receiver (`webhook-receiver.mjs`), pass in the `strapi-api` boot job on SQLite, MySQL and Postgres,
with `WebhooksTest` (the admin page and its trigger, the production url check, the admin's own
writes and publication changes, a rolled-back write, default headers); every earlier suite still
passes.

**Status (2026-10-21):** every suite passes on SQLite and Postgres with all caches on, and the
admin tests pass.

Known gaps: user accounts' writes are not events (Strapi sends `entry.create` and `entry.update`
for them). Strapi's `populateRelations: false` setting is not offered. A webhook is sent once,
with no retry, as on Strapi. The Strapi storage layout sends no webhooks (the Strapi instance
keeps them).

---

## Phase 27 — Dynamic zones and the strapi-php importer gaps (`ir-schema`, `adapter-kernel`, `adapter-strapi`, `adapter-filament`)

**Goal:** Strapi 5's dynamic zones work on the laravel storage layout with the Strapi API style, and
a strapi-php project imports without hand edits.

- Each component a zone holds keeps its items in its own child table of the content type
  (`<table>_<zone>_<component>`), with a `position` column holding the item's place in the zone.
  The serializer's `ZONES` names each member by uid; items go on the wire with `__component` and
  `id`, only when populate names the zone.
- Populate as Strapi reads it: `*`, `true` or the zone's name send the items without their own
  components; `[populate]` inside the zone adds them; `[on][uid]` keeps only the components it
  names, each with its own `fields` and `populate`. A zone cannot be filtered, sorted or selected
  (`Invalid key`, with its path).
- Writes: an update without the zone keeps it, one with it replaces it in its new order, `[]`
  clears it. An item naming a component the project lacks is refused with Strapi's message (which
  lists every component); one the zone does not hold is dropped; an item may name the id of one
  the entry holds, which keeps that row, and any other id is refused. Publishing and discarding
  copy the items with the version.
- The admin edits a zone with a Builder, one block per member, over the same rows.
- IR: a field may name the key it goes by on the API (`names.api`), unique among its siblings.
  The Strapi importer camelCases snake_case attributes and keeps their names there, so the
  Filament Strapi API sends and reads `hero_title` over the same `hero_title` column; it imports
  dynamic zones (the Strapi target writes them back), and reports morph relations, a dynamic zone
  inside a component, and a snake_case inverse (which has no field to keep its key) as gaps.

**Exit criteria:** the 21 checks of `dynamic-zone-vectors.json`, recorded from strapi-php, pass in
the `strapi-api` boot job on SQLite, MySQL and Postgres, with `DynamicZonesTest` (the Builder's
writes and reads, its order, publishing, and a caller without the grant refused); every earlier
suite still passes; strapi-php's `examples/getstarted` imports and generates.

**Status (2026-10-21):** every suite passes on SQLite and Postgres with all caches on, and the
admin tests pass. `examples/getstarted` imports with its gaps reported and its generated PHP lints.

Known gaps: a zone's member items are not validated against the component's required fields or
constraints before the write (the database's own constraints apply). A zone member's relations
and repeatable components stay gaps, as in any component on this layout. The Strapi storage layout
still reports dynamic zones. An inverse relation's snake_case name reaches the wire camelCased.

---

## Phase 28 — GraphQL content API (`adapter-kernel`, `cli`, `adapter-filament`)

**Goal:** Strapi 5's GraphQL plugin, opt-in (`graphql: true`), on the laravel storage layout with
the Strapi API style, with the schema Strapi prints for the same content types and the REST API's
grants, conditions, drafts, locales and errors.

- `graphql/schema.graphql` is printed at generation, definition for definition as strapi-php's
  (webonyx's) printer prints it for the same project: `Book`, `BookFiltersInput`, `BookInput`,
  `BookEntityResponseCollection` and `BookRelationResponseCollection`, `Component<Category><Name>`
  types with their filters and inputs, `<Type><Zone>DynamicZone` unions (plus `Error`) and their
  input scalars, `ENUM_<TYPE>_<FIELD>` enumerations, Strapi's scalars, `PaginationArg`,
  `Pagination`, `PublicationStatus`, `DeleteMutationResponse`, and the media library's
  `UploadFile` with its filters. Each type has `book`, `books` and `books_connection`, and
  `createBook`, `updateBook` and `deleteBook`, with `status` and, on a localized type, `locale`.
- `/graphql` (GET and POST, beside `/api`, behind the content API's own credentials) runs each
  root field as the REST action it names, through the generated controller, as the caller: the
  selection set becomes the request's populate, so a list costs what the REST list costs, and a
  relation asked for twice with different arguments is fetched per row for the second ask.
  Filters take Strapi's `$` operators, `status` and `locale` pass through, and a relation's
  pagination and the default page size (10, `camis.graphql`) are Strapi's GraphQL ones.
- A document the caller cannot see is null; errors carry Strapi's codes (`FORBIDDEN`,
  `BAD_USER_INPUT`, `STRAPI_PAGINATION_ERROR`, `GRAPHQL_VALIDATION_FAILED`) with the application
  error under `extensions.error`; a token that does not verify gets the REST 401 body.
- Shared hosting: the parsed schema is kept in `bootstrap/cache/camis-graphql.php` (rebuilt when
  the schema changes) for opcache to serve; `camis scaffold filament --graphql` installs
  `webonyx/graphql-php` and loads `routes/graphql.php` in `withRouting`'s `then:`, so
  `route:cache` keeps it.

**Exit criteria:** the generated schema's types, queries and mutations equal strapi-php's for the
same content types (`graphql-schema.strapi-php.graphql`); the 36 checks of `graphql-vectors.json`,
recorded from strapi-php, pass in the `strapi-api` boot job on SQLite, MySQL and Postgres, with
`GraphqlTest` (a caller without the grant refused and nothing written, a row condition hiding
another caller's rows from queries and mutations, a bad token's 401); every earlier suite still
passes.

**Status (2026-10-21):** every suite passes on SQLite and Postgres with all caches on, and the
PHP tests pass.

**Part 2 — the plugins' own fields and API tokens.** The schema now holds every type, query and
mutation strapi-php's has but `GenericMorph`:

- users-permissions: `login`, `register`, `me`, `forgotPassword`, `resetPassword`,
  `changePassword` and `emailConfirmation` run the REST auth controller (and its throttle, shared
  config); `usersPermissionsUser(s)` and the user mutations run the REST user controller; roles
  are read from the project's roles, with Strapi's names and descriptions for `authenticated` and
  `public`. As in Strapi, no role is granted a read of roles (so `UsersPermissionsUser.role` is
  refused without a token that has one); `UsersPermissionsMe.role` is always the caller's own.
- i18n: `i18NLocale(s)` (Strapi's `listLocales` scope) and `i18NLocales_connection` (its default
  `locale.find` scope, which no role holds).
- upload: `uploadFile(s)`, `updateUploadFile` and `deleteUploadFile` through the upload API.
- API tokens: `StrapiApiToken` lets a token through to `/graphql`, and each action the request
  runs is checked against it, so read-only and custom tokens reach exactly what they would on REST.
- Errors carry Strapi's GraphQL codes: `UnauthorizedError` is `FORBIDDEN` and `NotFoundError` is
  `STRAPI_NOT_FOUND_ERROR`.

Part 2's exit: the 63 checks of `graphql-plugin-vectors.json` (run by `strapi-auth-vectors.mjs`,
whose steps may now be GraphQL ones), recorded from strapi-php, pass on SQLite, MySQL and
Postgres, with `GraphqlTest` adding role mutations refused even to a full-access token, a role's
permissions refused, GraphQL sign-in throttled, and a custom token held to its actions. The REST
user controller now refuses a taken username as Strapi does (it raised a database error).

**Part 3 — publication filters and a file's related entries.** `publicationFilter` (Strapi's eight
cohorts: `never-published`, `has-published-version`, `modified`, `unmodified`, their
document-scoped `-document` forms, `published-without-draft`, `published-with-draft`) and the
deprecated `hasPublishedVersion` (document-scoped) narrow a draft-and-publish type's list and
findOne, over REST and GraphQL, by whether the other version of the document exists (in the same
locale unless document-scoped), comparing `updated_at` for `modified`. Every populated
draft-and-publish level inherits the cohort with the request's status, on REST and GraphQL alike,
as strapi-php does; an unknown value is a `ValidationError` on any type. The Upload API's
`populate=related` (or `*`) lists the entries each file is linked from, every version and link,
with their uid as `__type`, leaving out the types the caller may not read, at one query per linked
type. GraphQL's `UploadFile.related` is the same list as Strapi's `GenericMorph` union.

Part 3's exit: the 35 checks of `publication-filter-vectors.json` and the three new checks of
`media-vectors.json`, recorded from strapi-php, pass on SQLite, MySQL and Postgres. strapi-php
answers GraphQL's `UploadFile.related` with an internal error ("Missing schema in
validateQuery"), so `GraphqlTest` checks it instead, with a caller who may not read every linked
type. camis keeps timestamps to the second, so a draft edited within the second of its publish
reads as `unmodified` (the vectors wait a second between the two).

Known gaps (reported): role mutations (roles are the IR's, as on REST) and
`UsersPermissionsRole.permissions` (the IR's grants are not permission rows). Filters and sort on
a repeatable component are refused. The Strapi storage layout and the laravel API style generate
no GraphQL. A single type is served as a collection, as on REST.

---

## Phase 29 — OpenAPI, data transfer (`adapter-kernel`, `cli`, `adapter-filament`)

**Part 1 — the OpenAPI document and Swagger UI.** With the project option `documentation: true`
(`camis.config.json`), the Strapi API style on laravel storage writes Strapi 5's OpenAPI 3.1
document (`strapi openapi:generate`, `strapi/openapi`) to `public/documentation/openapi.json` and
Swagger UI beside it, so `/documentation` serves both as static files: no PHP, no Node, no
cache to warm. The document is built at generation time from the IR, reproducing the JSON Schema
Strapi's Zod route validators produce: each content type's five core routes with their query
parameters (`fields`, `filters`, `_q`, `pagination`, `sort`, `populate`, plus `locale` and the
draft-and-publish ones where they apply), request bodies and response documents, and the
registered schemas the documents refer to (relation and media targets, components). The
users-permissions, upload and i18n routes carry fixed, hand-written schemas in Strapi; they come
from `openapi-plugins.json`, recorded from strapi-php, and appear only when the project has the
plugin. Swagger UI comes from jsDelivr, pinned and integrity-checked.

Part 1's exit: `openapi.strapi-php.json`, written by strapi-php's `openapi:generate` with the
fixture's types added to its example project, equals ours route for route and schema for schema,
except the routes camis does not serve (the content-type builder, `POST /email`,
`GET /upload/files/page`); the boot job checks that `/documentation` answers and that each of
the 101 documented operations is a registered route. Strapi gives every `publishedAt` a default
that is the moment it ran; the generated document leaves it out (no timestamps in codegen) and
keeps the `required` it implies. `servers` is `/api`, where the routes are, rather than Strapi's
empty URL. The documentation plugin's OpenAPI 3.0 variant (with its admin-only fields) is not
generated.

**Part 2 — importing a Strapi export.** On the same style and layout, `php artisan strapi:import`
takes Strapi's `strapi import` options (`--file`, `--key`, `--force`, `--only`, `--exclude` over
`content`, `files`, `config`) and restores an archive `strapi export` wrote (`.tar`, `.tar.gz`,
`.tar.gz.enc`), so a Strapi project can move onto shared hosting. A generated
`StrapiTransferMap` says, per uid, which column, component columns or child rows each archived
key goes to and which Eloquent relation stores each link, with content types in an order that
sets required foreign keys on insert. The engine deletes the mapped content, inserts every entry
with its documentId and timestamps, resolves links through the archived-id → row-id map (a row
of a type without draft and publish links a draft-and-publish document's draft only, as camis
stores it), attaches media in order, and restores locales, the files' bytes on the upload disk,
users-permissions settings and webhooks. Users are matched by email, keeping their password
hashes, rather than deleted, because the same table holds the admin's accounts; a Strapi role
becomes the camis role of that name, else the default one. Decryption is Strapi's AES-128-ECB
under scrypt(key), with scrypt written out in PHP. The import refuses an archive with a content
type or attribute the project lacks, naming each; types and attributes only the project has stay
empty. All of it runs in one PHP process, with no queue or cron.

Part 2's exit: `transfer/strapi-php-export.tar.gz` and its encrypted twin, written by strapi-php
from `transfer/seed-vectors.json`, import in the boot job; the archive's user signs in with the
password strapi-php hashed, and the 16 reads of `read-vectors.json` (documentIds compared) answer
as strapi-php answers them after importing the same archive. Passes on SQLite and Postgres,
including a second import over the first.

Known gaps: roles' permissions, upload folders and admin data are not imported (the IR's grants
are the permissions; camis keeps a file's folder path only; Strapi does not export admin data).
Repeatable components inside a component are reported and left empty.

**Part 3 — exporting to Strapi.** `php artisan strapi:export` takes `strapi export`'s options
(`--file`, `--key`, `--no-encrypt`, `--no-compress`, `--only`, `--exclude`) and writes its archive,
so a camis project can move to Strapi (or strapi-php) generated from the same IR. Strapi's import
compares the archive's schemas with its own strictly, so the build writes Strapi's runtime
schemas for the IR (`resources/strapi/schemas.jsonl`): `@camis/strapi-schema`, lifted out of
`adapter-strapi` so both adapters share the IR → schema mapping, adds what Strapi's loader adds
(system attributes, model keys) and carries the plugins' and admin's schemas recorded from
strapi-php. The engine reads the rows back through `StrapiTransferMap`: entries in Strapi's REST
shape with components inline, links from the declaring side with list positions (a type without
draft and publish links both versions of a draft-and-publish document, as Strapi does), media as
morph links, files with their bytes and metadata under Strapi's local `/uploads`, users with
their hashes, roles with Strapi's default users-permissions actions plus the IR's grants
(`StrapiTransferMap::ACTIONS`), and the users-permissions, locale and webhook settings. The
archive is written as a ustar stream, gzipped and encrypted a megabyte at a time.

Part 3's exit: in the boot job, strapi-php's archive imported and exported again holds the same
entries, links, files and settings (`scripts/strapi-transfer-compare.mjs`), and imports again
with the same 16 reads, plain and encrypted, on SQLite, MySQL and Postgres. strapi-php itself
imports camis's export (checked locally against the oracle) and answers the 16 reads as before.
The export also fixes the import's email templates, which Strapi keeps under `options`.

Known gaps: upload folders and admin data are not exported, nor the content manager's view
settings. Transfer tokens and `strapi transfer` between live instances (a websocket, which PHP-FPM
cannot hold) are the next parts.

**Part 4 — transfer tokens.** The admin's Settings › Transfer Tokens page makes, lists,
regenerates and deletes Strapi's transfer tokens: push, pull or both, for 7, 30 or 90 days or
unlimited, kept as an HMAC-SHA512 of the key salted with `TRANSFER_TOKEN_SALT` (Strapi's own, so a
project moving off Strapi keeps its tokens' hashes), and shown once, as Strapi shows them.
`strapi transfer`'s runner, `GET /admin/transfer/runner/{push,pull}`, is answered as strapi-php
answers it under FPM: no or an unknown token is 401, an expired one 401 `Token expired`, one
without the scope 403, and a valid one 501, since the runner is a WebSocket. The 501 names the
archive commands that move the same data. The routes live in `routes/transfer.php`, which `camis
scaffold` loads from `bootstrap/app.php`'s routing beside `routes/graphql.php`, so `route:cache`
keeps them.

Part 4's exit: `transfer-token-vectors.json` (12 requests: each scope, a content API token, an
expired, regenerated and revoked token) answers in the boot job as strapi-php answers it, on
SQLite, MySQL and Postgres; `TransferTokensTest.php` covers the admin page, lifespans and the
hourly last use.

Known gap (reported as `remoteDataTransfer`): `strapi transfer --to/--from` itself. A host with a
shell moves data with `strapi:export` and `strapi:import`.

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
