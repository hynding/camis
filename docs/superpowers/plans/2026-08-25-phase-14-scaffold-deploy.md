# Phase 14 — Scaffold & Deploy Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command (`camis scaffold filament <dir>`) creates the Laravel 12 + Filament v5 + Spatie host app the overlay needs; the Filament target emits a `DEPLOY.md` covering env-driven DB selection and shared-hosting deployment; the `camis` bin runs under plain `node`.

**Architecture:** `Io` gains `exec(cmd, args, cwd)` so the scaffold command is a deterministic, fully mockable sequence of the exact steps proven in `.github/workflows/adapter-filament-boot.yml` (composer create-project → filament:install → spatie install/publish → `HasRoles` patch). The `User.php` patch is a pure function. `DEPLOY.md` is one more `GeneratedFile` from the Filament adapter. Bin runnability comes from a `bin/camis.mjs` wrapper that registers tsx's ESM loader at runtime, keeping the no-build src-consumption convention.

**Spec:** Phase 14 in `docs/PLAN.md`. Scaffold recipe source of truth: `.github/workflows/adapter-filament-boot.yml` (steps "Scaffold Laravel 12 + Filament v5" and "Install Spatie + HasRoles").

## Global Constraints

- Scaffold must refuse to run into a directory that already contains a `composer.json` (no clobbering).
- The `HasRoles` patch must be idempotent (running scaffold twice, or on an already-patched User model, must not duplicate the trait).
- `DEPLOY.md` is `overwrite` mode (generator-owned documentation); it must NOT emit `.env` or touch Laravel's `.env.example`.
- Composer/artisan invocations always pass `--no-interaction`.
- Exec failures abort with the failing command echoed; exit code non-zero.

---

### Task 1: Io.exec + `camis scaffold filament <dir>`

**Files:**
- Modify: `packages/cli/src/io.ts` (add `exec(cmd: string, args: string[], cwd: string): Promise<number>`)
- Modify: `packages/cli/src/bin.ts` (real exec via `node:child_process` spawn, stdio inherit)
- Create: `packages/cli/src/commands/scaffold.ts` (`scaffoldCommand(target, dir, io)` + exported pure `patchUserModel(source: string): string`)
- Modify: `packages/cli/src/run.ts` (dispatch + usage)
- Test: `packages/cli/src/commands/scaffold.test.ts`

**Interfaces:**
- Produces: `scaffoldCommand(target: string, dir: string, io: Io): Promise<number>`; command sequence (cwd `dir` unless noted):
  1. `composer create-project laravel/laravel:^12 <dir> --no-interaction` (cwd: parent)
  2. `composer require filament/filament:^5.0 --no-interaction`
  3. `php artisan filament:install --panels --no-interaction`
  4. `composer require spatie/laravel-permission --no-interaction`
  5. `php artisan vendor:publish --provider=Spatie\Permission\PermissionServiceProvider --no-interaction`
  6. read `app/Models/User.php`, `patchUserModel`, write back

- [ ] **Step 1: Failing tests** — mock Io.exec recording `{cmd, args, cwd}`: happy path runs the 6 steps in order and returns 0; `composer.json` already present in dir → exit 1, zero execs; first failing exec (non-zero) aborts the sequence; `patchUserModel` adds `HasRoles` to `use HasFactory, Notifiable;` and is idempotent; unknown scaffold target → exit 1.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** — `patchUserModel` mirrors the CI patch: replace `use HasFactory, Notifiable;` with `use HasFactory, Notifiable, \Spatie\Permission\Traits\HasRoles;` only when the trait is absent. Existence check via `io.readFile(join(dir, "composer.json"))` succeeding → refuse.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(cli): camis scaffold filament — host-app creation with HasRoles patch`

### Task 2: Filament adapter emits DEPLOY.md

**Files:**
- Create: `packages/adapter-filament/src/deploy.ts` (`deployFile(): GeneratedFile`)
- Modify: `packages/adapter-filament/src/generate.ts` (append)
- Test: `packages/adapter-filament/src/generate.test.ts` assertion + file-listing golden update (deliberate)

- [ ] **Step 1: Failing test** — every generation includes `DEPLOY.md` containing `DB_CONNECTION`, `php artisan migrate`, and the seeder command hint.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** — content covers: env-driven DB selection (sqlite/mysql/pgsql blocks), migrate + `db:seed --class=RolePermissionSeeder` (only meaningful when roles were configured), `filament:optimize`, shared-hosting notes (build locally, upload, docroot → `public/`), AI provider stub warning.
- [ ] **Step 4:** Run — PASS; regenerate `file-listing.txt` goldens (catalog) deliberately.
- [ ] **Step 5: Commit** `feat(adapter-filament): emit DEPLOY.md with env-driven DB + shared-hosting guidance`

### Task 3: bin runs under plain node

**Files:**
- Create: `packages/cli/bin/camis.mjs` (`#!/usr/bin/env node`, `register()` from `tsx/esm/api`, dynamic-import `../src/bin.ts`)
- Modify: `packages/cli/package.json` (`bin` → `bin/camis.mjs`, dependency `tsx`)
- Test: `packages/cli/src/bin-smoke.test.ts` — spawn `node bin/camis.mjs help`, expect exit 0 + usage on stdout

- [ ] **Step 1: Failing test** (spawnSync node bin/camis.mjs help) — FAIL (file absent).
- [ ] **Step 2: Implement**; `pnpm add --filter @camis/cli tsx`.
- [ ] **Step 3:** Run — PASS.
- [ ] **Step 4: Commit** `feat(cli): bin wrapper registers tsx so camis runs under plain node`

### Task 4: Real end-to-end validation + docs + merge

- [ ] **Step 1:** In the scratchpad (PHP 8.4 + Composer 2.8 present): `node bin/camis.mjs scaffold filament <dir>` → `camis build` (OYL config with roles, out → the app dir) → `php artisan migrate` (sqlite) → `php artisan db:seed --class=RolePermissionSeeder`. Expect all green; record runtime.
- [ ] **Step 2:** Docs: CLI README scaffold section + PLAN exit criteria.
- [ ] **Step 3:** `pnpm -r test` + typecheck; merge `phase-14-scaffold-deploy`.
