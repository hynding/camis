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
