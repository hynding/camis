# Phase 15 — Laravel Sync API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Filament target can serve as a headless backend: generated JSON API controllers + routes per content type, declarative upsert (`options.upsertBy`), and a protected seam (`routes/api-custom.php`, seed mode) for bespoke endpoints such as an OYL `/api/bootstrap`.

**Architecture:** The IR gains `options.upsertBy?: <fieldName>` (validated: the field exists, is unique, and is scalar). The Filament adapter emits `app/Http/Controllers/Api/<Model>ApiController.php` (index/show/store/update/destroy; store upserts via `updateOrCreate` when `upsertBy` is set) and `routes/api.php` (overwrite, marker header) that registers resource routes and `require`s the seed-mode `routes/api-custom.php`. When roles are configured, routes carry `auth` middleware (Sanctum, installed by scaffold's `install:api` step) and controllers call `$this->authorize(...)` so the Phase-13 policies enforce on API paths. Builtin content types emit no API.

**Spec:** Phase 15 in `docs/PLAN.md`. OYL's sync protocol needs: CRUD JSON per collection, upsert-by-`recordId`, bespoke aggregate endpoints implementable in a protected file.

## Global Constraints

- `routes/api.php` is generator-owned (`overwrite`, marker); `routes/api-custom.php` is `seed` and never overwritten — same protection contract as hooks.
- `upsertBy` invariant errors are IR validation errors (`unknown_upsert_field`, `non_unique_upsert_field`), not gaps.
- Embedded component columns are writable API fields; repeatable child tables are excluded from API payloads (documented boundary).
- Laravel's `install:api` is required for `routes/api.php` to load — scaffold gains the step; DEPLOY.md documents it for existing apps.
- Determinism: routes sorted by table name; controller field lists in field order.

---

### Task 1: IR — `options.upsertBy` + invariants

**Files:**
- Modify: `packages/ir-schema/src/document.ts` (options object gains `upsertBy: fieldName.optional()`)
- Modify: `packages/ir-core/src/invariants.ts` (existence + uniqueness + scalar checks)
- Test: `packages/ir-schema/src/document.test.ts`, `packages/ir-core/src/invariants.test.ts`

- [ ] Failing tests: accepts `options.upsertBy: "recordId"` when `recordId` is a unique scalar; `unknown_upsert_field` when absent; `non_unique_upsert_field` when the named field lacks `unique: true`.
- [ ] Implement; run; commit `feat(ir-schema,ir-core): declarative upsert key via options.upsertBy`

### Task 2: Filament — API controllers

**Files:**
- Create: `packages/adapter-filament/src/api.ts` (`emitApiController(ct, emits, opts)`)
- Test: `packages/adapter-filament/src/api.test.ts`

Controller contract (per non-builtin collection type):
- `index()` → `Model::query()->paginate(50)`; secured: `authorize('viewAny')` + ownership handled by policy-filtered `view` on each? (Bounded: index authorizes `viewAny` only; record conditions apply on show/update/destroy.)
- `show/update/destroy` → route-model binding, secured versions authorize `view`/`update`/`delete` (policies carry the Ring-1 ownership conditions from Phase 13).
- `store()` → `only([...fillable])`; with `upsertBy`: `updateOrCreate([col => $payload[col]], $payload)`; else `create`.

- [ ] Failing tests: unsecured Note controller contains `Note::create($payload)`; upsert variant contains `updateOrCreate(['record_id' => $payload['record_id'] ?? null], $payload)`; secured variant contains `$this->authorize('update', $note);`.
- [ ] Implement; run; commit `feat(adapter-filament): JSON API controllers with declarative upsert`

### Task 3: Filament — routes + protected seam; generate wiring

**Files:**
- Modify: `packages/adapter-filament/src/api.ts` (`emitApiRoutes(cts, secured)`, `apiCustomSeed()`)
- Modify: `packages/adapter-filament/src/generate.ts`
- Test: `packages/adapter-filament/src/generate.test.ts` + file-listing goldens (deliberate)

- [ ] Failing tests: generation emits `routes/api.php` (contains `Route::apiResource('notes', NoteApiController::class)` and `require __DIR__.'/api-custom.php';`), `routes/api-custom.php` with `mode: "seed"`; secured generation wraps resources in `Route::middleware('auth')->group(...)`; builtin User gets no routes/controller; regen preserves a hand-edited `api-custom.php` (seed regen test, mirroring `hooks/regen.test.ts`).
- [ ] Implement; run (regen goldens deliberately); commit `feat(adapter-filament): generated routes/api.php with protected api-custom seam`

### Task 4: Scaffold gains `install:api`

**Files:**
- Modify: `packages/cli/src/commands/scaffold.ts` (step after `filament:install`: `php artisan install:api --no-interaction`)
- Test: `packages/cli/src/commands/scaffold.test.ts` sequence assertion update

- [ ] Failing test (sequence now 6 execs); implement; commit `feat(cli): scaffold installs Laravel's API layer (sanctum + routes)`

### Task 5: End-to-end against the scaffolded app + docs + merge

- [ ] With the Phase-14 scratchpad app: add `upsertBy: "recordId"` to OYL personal types in the IR, rebuild overlay, `php artisan migrate:fresh --seed`, `php artisan route:list` shows `api/notes` etc.; `php artisan tinker` round-trip: two stores with the same `record_id` yield one row (upsert).
- [ ] Docs: CLI README API section; DEPLOY.md gains `install:api` note; PLAN exit criteria.
- [ ] `pnpm -r test` + typecheck; merge `phase-15-laravel-sync-api`.
