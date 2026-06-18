# Phase 6A — Filament Vertical Slice (`adapter-filament`) Design

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 6, sub-phase A (of A/B/C)
**Scope:** generate the IR-derived overlay for a Laravel 12 + **Filament v5** app for ONE content
type (Article, scalar fields) — an Eloquent model, a migration, and a Filament Resource
(Form + Table + Pages). Prove the cross-language scaffold path with golden + structural tests
per commit and a gated CI job that scaffolds, overlays, migrates, and boots on
`sqlite | mysql | pgsql`.

---

## 1. Context & goal

Phase 6 (the cross-language path) is decomposed into three sub-phases: **6A** vertical slice
(this spec), **6B** breadth (full field taxonomy + relations + components), **6C** the permission
spine (Spatie + Ring-1 → PHP Policies + enforcement smoke). 6A de-risks the hardest unknown
first — *can camis generate a Laravel/Filament app that actually boots?* — with the smallest
content surface, before adding breadth or the permission spine.

The `adapter-filament` package is currently a Phase-0 stub. Phase 4 already delivered the
Ring-1 PHP engine (`emitPhp` + `PHP_RUNTIME`), but 6A does NOT use it (no permission predicates
yet) — 6A is pure content → Laravel/Filament emission.

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Target Filament v5** (`^5.0`) on Laravel 12. Resources follow v5's layout: `app/Filament/Resources/<Plural>/{<Singular>Resource.php, Schemas/<Singular>Form.php, Schemas/<Plural>Table.php, Pages/*.php}`. | Current stable (v5.1.1), Laravel 12-native; matches the project's "target the current stable" ethos. |
| D2 | **Overlay, not standalone.** `generate()` emits ONLY IR-derived files (model, migration, Resource). The base app (framework + `AdminPanelProvider` that auto-discovers `app/Filament/Resources`) is scaffolded by the official `laravel new` + `filament:install --panels` in the gated job. | "Generated = IR-derived, owned & overwritten." We do not own/version-track Laravel's ~40 framework files; Filament auto-discovers our Resources. |
| D3 | **Deterministic ordinal migration filenames**, never timestamps: `0000_00_00_000001_create_<table>_table.php`, incrementing in sorted content-type order. | CLAUDE.md determinism — golden files and idempotent regen require no timestamps; Laravel orders migrations lexically by filename, so ordinals preserve order. |
| D4 | **Multi-DB is env-driven and (almost) free.** camis emits NO database config code; Laravel's stock `config/database.php` selects the driver by `DB_CONNECTION`. Our only obligation: **portable migrations** (schema-builder types valid on sqlite/mysql/pgsql). | "No code change between environments" is Laravel's default; the gated job's matrix sets env per DB. |
| D5 | **Verification = golden + structural per commit; boot is a gated CI job.** No PHP execution in the per-commit loop. The gated `adapter-filament-boot` job is the integration truth oracle for the v5 file layout. | Matches the chosen verification depth and the Phase 2 gated-smoke precedent; `composer install` needs network/DB. |
| D6 | **`generate(ir: IrBundle)` reads `ir.document`, ignores `ir.roles`.** | Permissions are 6C; 6A honors the kernel contract without emitting permission artifacts. |
| D7 | **6A content surface = scalar fields only**, representative subset (string, text, boolean, integer, dateTime). One driving mapping table feeds all three emitters (migration column, form component, table column). | Full taxonomy, relations, and components are 6B; keep the slice minimal. |
| D8 | **The full `sqlite|mysql|pgsql` matrix lives in 6A's gated job** (not deferred). | Proving portability early is cheap (CI matrix config) and de-risks 6C, which needs multi-DB enforcement. |

## 3. Packages & dependency direction

- **`@camis/adapter-filament`** (fills the stub) — a `GenerateAdapter`. Deps: `adapter-kernel`
  (`GenerateAdapter`, `GeneratedFile`, `GenerationResult`, `buildManifest`, `stableJson`),
  `ir-schema` (types), `ir-core` (`normalize`), `permissions` (the `IrBundle` type). NOT
  `expr-php-emit` (6C). **Never imports `adapter-strapi`** (sibling-adapter rule); Filament PHP
  templates live in this package.
- ESLint boundary: the existing adapter rule (`["@camis/adapter-*", "!@camis/adapter-kernel"]`)
  already permits `adapter-filament → kernel/ir-schema/ir-core/permissions`; confirm `pnpm lint`
  stays clean.

## 4. Overlay file set (Article)

`generate(ir, { projectName })` → `GenerationResult` whose `files` are the overlay (only when the
document has content types). For `Article`:

1. **`app/Models/Article.php`** — `final class Article extends Model`; `protected $table = 'articles';`
   `protected $fillable = [...]` (IR field names, in IR order); `protected $casts = [...]` for
   typed fields (`boolean`, `datetime`/`immutable_datetime`, `array`/`json`). PSR-12.
2. **`database/migrations/0000_00_00_000001_create_articles_table.php`** — `return new class extends Migration { public function up(): void { Schema::create('articles', function (Blueprint $table) { $table->id(); … $table->timestamps(); }); } public function down(): void { Schema::dropIfExists('articles'); } };`
   Columns mapped from IR fields; `->nullable()` when `required` is not true; column order = IR order.
3. **`app/Filament/Resources/Articles/ArticleResource.php`** — `protected static ?string $model = Article::class;` navigation icon/label; `form(Schema $schema)` → `ArticleForm::configure($schema)`;
   `table(Table $table)` → `ArticlesTable::configure($table)`; `getPages()` → List/Create/Edit routes.
4. **`app/Filament/Resources/Articles/Schemas/ArticleForm.php`** — `ArticleForm::configure(Schema $schema): Schema` returning `$schema->components([...])` (one component per field).
5. **`app/Filament/Resources/Articles/Schemas/ArticlesTable.php`** — `ArticlesTable::configure(Table $table): Table` returning `$table->columns([...])`.
6. **`app/Filament/Resources/Articles/Pages/{ListArticles,CreateArticle,EditArticle}.php`** — the
   thin v5 page classes the Resource's `getPages()` references.

The exact v5 class/namespace/path layout is pinned in the plan against the v5 docs and is
**validated by the gated boot job** (the integration truth oracle).

## 5. Field mapping (scalars, 6A)

A single table in `fields.ts` maps each IR scalar type → `{ migration, formComponent, tableColumn }`:

| IR type | migration | form component | table column |
|---------|-----------|----------------|--------------|
| string | `$table->string('<name>')` | `TextInput::make('<name>')` | `TextColumn::make('<name>')` |
| text | `$table->text('<name>')` | `Textarea::make('<name>')` | `TextColumn::make('<name>')` |
| boolean | `$table->boolean('<name>')` | `Toggle::make('<name>')` | `IconColumn::make('<name>')->boolean()` |
| integer | `$table->integer('<name>')` | `TextInput::make('<name>')->numeric()` | `TextColumn::make('<name>')` |
| dateTime | `$table->dateTime('<name>')` | `DateTimePicker::make('<name>')` | `TextColumn::make('<name>')->dateTime()` |

`required` toggles migration `->nullable()` (absent → nullable) and form `->required()`. Types
outside this subset are out of scope for 6A (they arrive in 6B); if the fixture contained one, the
emitter would record a capability-gap rather than emit — but the 6A fixture uses only the subset.

## 6. Naming (`names.ts`)

- Model class: StudlyCase singular (`Article`). Table: snake_case plural (`articles`).
- Resource dir: StudlyCase plural (`Articles`); `ArticleResource`, `ArticleForm`, `ArticlesTable`,
  page classes per v5. Derive plural via the IR `names.plural` when present, else a deterministic
  pluralizer (the same casing source already used by `adapter-strapi` lives in *that* adapter;
  Filament needs its own StudlyCase/snake helpers here — no cross-adapter import).

## 7. Gated CI boot job (`.github/workflows/adapter-filament-boot.yml`)

Triggers: `workflow_dispatch` + `pull_request` + nightly `schedule`. Matrix:
`db: [sqlite, mysql, pgsql]` with mysql/pgsql as service containers. Steps: checkout → setup-php
8.3 → setup-node/pnpm → `laravel new app` (Laravel 12) → `composer require filament/filament:"^5.0"`
→ `php artisan filament:install --panels --no-interaction` → run the camis generator to overlay our
files into `app/` → `composer install` → set `DB_CONNECTION` for the matrix entry →
`php artisan migrate --force` → boot check (`php artisan about` and `php artisan filament:check`
or equivalent). Green = the overlay integrates and the app boots/migrates on that DB.

(How the generator is invoked in CI — a small `camis generate` entrypoint or a script calling
`filamentAdapter` + `materialize` into the scaffolded dir — is pinned in the plan.)

## 8. Testing (per-commit)

- **Golden** (`packages/adapter-filament/src/__golden__/`): each emitted PHP file byte-exact for an
  `Article` fixture (Model, migration, Resource, Form, Table, the three Pages).
- **File-listing golden:** sorted `mode path` listing of all emitted files.
- **Idempotent regen:** `generate(bundle) deep-equals generate(bundle)`.
- **Mapping unit tests:** each scalar IR field → its migration column fragment, form component,
  table column (table-driven).
- **A second content type** in a fixture exercises ordinal migration ordering (`…000001…`,
  `…000002…`) deterministically.
- No PHP execution per commit (D5).

## 9. Exit criteria (6A)

- `Article` (scalars) generates a complete, well-formed Filament v5 overlay (model + migration +
  Resource/Form/Table/Pages), golden-locked and idempotent (second run = no diff).
- The gated `adapter-filament-boot` job scaffolds + overlays + `composer install` + migrates and
  boots on `sqlite | mysql | pgsql`.
- `pnpm lint` / `pnpm -r typecheck` / `pnpm -r test` green; per-commit CI green.
- Out of scope (deferred): relations, full field taxonomy, components (6B); Spatie permissions,
  Policies, Ring-1 → PHP, enforcement smoke (6C).

## 10. Cross-cutting

- The IR is the single source of truth; `adapter-filament` is neutral-in / Laravel-Filament-out.
  All Laravel/Filament-isms (Eloquent, Blueprint, Filament Resource/Schema APIs, panel discovery)
  are confined to this adapter.
- One-way authoritative generation: IR → Filament overlay; nothing parses generated PHP back into
  IR (Filament import, if ever, is a far-future concern and not in 6A).
- Determinism: ordinal migration names, PSR-12 stable formatting, stable field/column ordering, no
  timestamps — so golden files and idempotent regen hold.
- The PHP emitter (this adapter) needs no PHP runtime to build or to run its golden tests; only the
  gated boot job needs PHP/Composer/databases.
