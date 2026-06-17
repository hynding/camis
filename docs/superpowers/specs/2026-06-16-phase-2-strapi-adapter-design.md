# Phase 2 — First Vertical Slice: Strapi Adapter Design (`adapter-kernel`, `adapter-strapi`)

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 2
**Scope:** IR → a runnable Strapi v5 project for a single `Article` collection type, proving the
IR design against the most mature reference. Establishes the generate-adapter contract, the
marker/manifest system, deterministic codegen, and golden + smoke testing.

---

## 1. Context & goal

This is the first end-to-end vertical slice: take a validated IR document (Phase 1) and emit a
Strapi v5 project that boots and exposes the content type. It proves "is the IR right?" against
the maturity benchmark before any breadth. Two packages: `adapter-kernel` (shared codegen
contract + marker/manifest + deterministic emission) and `adapter-strapi` (the Strapi mapping).

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Generated outputs live in `generated/<project>-strapi/` (root-level, git-ignored, disposable).** `apps/` is reserved for future management/UI applications, not generated CMS outputs. | User decision. Matches "generated apps are disposable outputs"; keeps the repo clean; frees `apps/` for first-class apps later. |
| D2 | **Generated projects are standalone outputs, NOT pnpm-workspace members.** | They own their toolchain (npm + Strapi); they are build artifacts, not source packages. |
| D3 | **In-memory generation + idempotent `materialize`.** Adapters are pure: `generate(doc) → GenerationResult` with no disk I/O; the kernel's `materialize` writes to disk. | Clean separation; golden tests assert on in-memory files (no temp dirs); deterministic. |
| D4 | **From-scratch deterministic generation** — the adapter owns the whole minimal Strapi skeleton (pinned `@strapi/strapi`); no `create-strapi-app`, no network scaffolder. | Determinism + one-way-authoritative-generation prime directives; enables byte-exact golden tests and idempotent regen. |
| D5 | **Hybrid testing:** golden + structural smoke in per-commit CI; an authoritative generate→install→boot→query smoke as a gated/on-demand job (sqlite). | The real boot satisfies the exit criterion without making every commit slow/flaky. |
| D6 | **Programmatic `generate()` API this phase; the `camis` CLI is deferred to Phase 10.** | Keeps Phase 2 scoped to the adapter, not CLI ergonomics. |
| D7 | **`softDelete` → capability-gap entry** (Strapi has no native soft delete); `timestamps` is a no-op (always-on in Strapi). | Targets can't represent every IR feature; surface gaps loudly, never silently drop. |
| D8 | **Three file modes in the kernel: `overwrite` (generated, manifest-tracked), `seed` (write-once: emit if absent, never overwrite), and protected (untracked, untouched).** `.env` is `seed`. | A regenerated `.env` would clobber a user's real secrets; seed write-once protects them while still bootstrapping a fresh project. |
| D9 | **Pin an exact `@strapi/strapi@5.x.y`** (latest stable v5 validated at implementation time); golden files are tied to that version. Bumping Strapi = regenerate goldens. | Skeleton shape + boot behavior vary across minors; byte-exact goldens require a fixed version. |
| D10 | **Derive the skeleton from a real `create-strapi-app` v5 scaffold ONCE during development**, strip to minimal, freeze as deterministic templates. | D4 forbids the scaffolder at *generation* time, not as a one-time source of a known-bootable skeleton. De-risks "does it actually boot." |
| D11 | **`generate()` normalizes its input via `ir-core` first** (name projection depends on `names.*`). | Reliable name derivation regardless of caller. |
| D12 | **Generated output is deterministic:** fixed placeholder `.env` secrets (dev-only), `stableJson` preserves insertion order (no key sorting), manifest self-excluded and `stableJson`-serialized. | Random secrets or key-sorting would break golden + idempotency and reorder admin fields. |

## 3. `adapter-kernel` — shared codegen foundation

Depends on `@camis/ir-schema` (for `IrDocument`, `CapabilityGapReport`). No sibling-adapter deps.

- **`GeneratedFile`** = `{ path: string; content: string; mode?: "overwrite" | "seed" }` — `path` is relative to the project root, POSIX separators; `mode` defaults to `"overwrite"`.
- **`GenerationResult`** = `{ files: GeneratedFile[]; manifest: Manifest; gaps: CapabilityGapReport }`.
- **`GenerateAdapter`** contract: `{ target: string; generate(doc: IrDocument, options: GenerateOptions): GenerationResult }`. `GenerateOptions` carries at least `{ projectName: string }`.
- **Three file categories** (ARCHITECTURE §1.3):
  - **`overwrite`** (generated) — manifest-tracked; rewritten every regen; deleted when dropped from a prior manifest.
  - **`seed`** — written **only if absent** (e.g. `.env`); a user's edits are never clobbered. Still recorded so we know we created it.
  - **protected** — any path not produced by the generator; never touched.
- **Marker / manifest system:**
  - A `.camis/manifest.json` in each output lists every generated file `path`, its `mode`, and a content hash (sha256). The manifest **excludes itself** and is `stableJson`-serialized.
  - Comment-friendly files (`.ts`) also carry an inline header marker `// @camis:generated — do not edit; regenerated by camis`. JSON files (e.g. `schema.json`) cannot hold comments and rely on the manifest alone.
- **Deterministic emission utilities:**
  - `stableJson(value)` — stable *formatting* (2-space indent, trailing newline, no timestamps) that **preserves insertion order** (does NOT sort keys; the adapter controls field order by construction).
  - Files always produced in sorted `path` order.
- **`materialize(result, destDir)`** — writes `overwrite` files; writes `seed` files only when absent; reads any prior `.camis/manifest.json` and deletes `overwrite` files no longer present; writes the new manifest; never touches protected paths. **Idempotent**: a second `materialize` produces zero changes (seed files already exist; overwrite files are byte-identical).

## 4. `adapter-strapi` — the Strapi v5 mapping

Depends on `adapter-kernel` + `@camis/ir-schema` + `@camis/ir-core`. Implements `GenerateAdapter`
with `target: "strapi"`. `generate()` **normalizes the input doc via `ir-core` first** (D11), then
emits API directories for **every content type in the document** (so a relation's target type
exists and the project boots).

### 4.1 Name projection (target-specific)
From the IR canonical `name` (PascalCase, e.g. `Article`), derive Strapi names (kebab-case is
mandatory for singular/plural):
- `singularName` = kebab-lower of name (`Article`→`article`, `BlogPost`→`blog-post`)
- `pluralName` = kebab-lower plural (`articles`, `blog-posts`)
- `collectionName` = snake plural (reuse IR `names.collection`, e.g. `articles`, `blog_posts`)
- `displayName` = IR `names.display` (humanized)
- uid = `api::<singularName>.<singularName>`
IR `names` overrides win.

### 4.2 Field-type mapping (the casing quirks live ONLY here)
| IR type | Strapi `type` | Notes |
|---------|---------------|-------|
| string, text, email, uid, integer, float, decimal, boolean, json, media, date, time, timestamp | same string | 1:1 |
| richText | `richtext` | casing |
| bigInteger | `biginteger` | casing |
| dateTime | `datetime` | casing |
| enumeration | `enumeration` | + `enum: values` |
| relation | `relation` | see 4.3 |
| component / dynamicZone | `component` / `dynamiczone` | **deferred** (§6) |

Constraints: `required`, `unique`, `minLength`/`maxLength` (text-ish), `min`/`max` (numeric),
`default`, `enum` (enumeration). Omit absent constraints (don't emit `undefined`).

### 4.3 Relation mapping
`{ type: "relation", relation: <relationKind>, target: "api::<targetSingular>.<targetSingular>", inversedBy?: <inverse> }`.
Single-declaration owner side (D9 from Phase 1): emit `inversedBy` when the IR relation has an
`inverse`; otherwise unidirectional (no inversedBy/mappedBy).

### 4.4 Options
- `draftPublish` → `options.draftAndPublish: true` (omit when false).
- `timestamps` → no-op (Strapi always adds createdAt/updatedAt).
- `softDelete` → **capability-gap** (`severity: "downgrade"`, message naming the type); never emitted.

### 4.5 Emitted project layout (`generated/<project>-strapi/`)
Static skeleton — deterministic templates **derived once from a real `create-strapi-app` v5
scaffold** (D10), pinned to an exact `@strapi/strapi@5.x.y` (D9), `overwrite` mode unless noted:
- `package.json` (exact-pinned `@strapi/strapi`; scripts `develop`/`build`/`start`), `tsconfig.json`,
  `config/{server,admin,database,middlewares,api}.ts`, `src/index.ts`.
- `config/database.ts` defaults to **sqlite** (`DATABASE_FILENAME`, `.tmp/data.db`), env-driven.
- `.env` — **`seed` mode** (write-once; D8) with **fixed dev-only placeholder secrets** (`APP_KEYS`,
  `API_TOKEN_SALT`, `ADMIN_JWT_SECRET`, `JWT_SECRET`, `TRANSFER_TOKEN_SALT`) so output stays
  deterministic and a user's real secrets are never overwritten.

Generated regions (IR-derived, per content type):
- `src/api/<singular>/content-types/<singular>/schema.json`
- `src/api/<singular>/controllers/<singular>.ts` (`factories.createCoreController('api::x.x')`)
- `src/api/<singular>/routes/<singular>.ts` (`factories.createCoreRouter`)
- `src/api/<singular>/services/<singular>.ts` (`factories.createCoreService`)

`.camis/manifest.json` tracks all generated files.

## 5. Output & repo model

- Outputs land in `generated/<project>-strapi/` — root-level, **git-ignored**, disposable, NOT a
  workspace member.
- **Repo changes this phase:** add `generated/` to `.gitignore`; **exclude `**/__golden__/**` and
  `**/__fixtures__/**` from Prettier and ESLint** (golden files are byte-compared — a formatter
  touching them would break tests); leave `pnpm-workspace.yaml` without a `generated/*` glob;
  update ARCHITECTURE §2 + README layout (the generated-output dir is `generated/`, and `apps/` is
  reserved for future management UIs); resolve the CLAUDE.md "Open decisions" entry for `apps/`.

## 6. Scope boundaries (YAGNI)

**In scope:** `adapter-kernel` (contract, manifest, deterministic emit, materialize); `adapter-strapi`
generate for collection types with **scalar fields + relations + options**; the bootable skeleton;
programmatic `generate()`; golden + structural + gated-boot tests.

**Deferred:** components & dynamicZones (first needed by Phase 3's round-trip); single types;
permissions (Phase 5); the `camis` CLI (Phase 10); Filament/PHP (Phase 6); import (Phase 3).

## 7. Testing

- **Golden** (`adapter-strapi/__golden__/`): a **multi-type** fixture — `Article` (scalars +
  draftPublish + a `manyToOne` relation to `Author` with an inverse) **and** `Author` — so the
  relation target resolves and both API trees are emitted. Golden = exact `schema.json` for both
  types + the full emitted file set, byte-compared. An **idempotency** test: `generate` twice →
  identical `GenerationResult`; `materialize` twice → no disk diff.
- **Kernel unit tests:** `stableJson` determinism + insertion-order preservation; `materialize`
  writes `overwrite` files, preserves a hand-written protected file across regen, deletes files
  dropped from the manifest, and does **not** overwrite a user-modified `seed` file (write-once).
- **Structural smoke** (fast, per-commit CI): materialize to a temp dir; assert valid JSON in
  `schema.json`, the expected file tree exists, `package.json` parses and pins Strapi.
- **Boot smoke** (gated/on-demand job + local; NOT per-commit): triggers on **`workflow_dispatch`**
  (+ optional nightly `schedule`), runs on **Node 20** (Strapi-blessed LTS — the monorepo dev/CI
  uses Node 22, but the generated Strapi app boots under Node 20). Steps: `generate → materialize →
  npm ci → strapi start` on sqlite → assert the `Article` type is exposed. **Note:** a fresh
  Strapi denies the public REST route by default, so `GET /api/articles` returns **403**, not 200,
  until the Public role is granted `find`. The smoke therefore treats the route as *exposed* if it
  returns a **registered** response (**200 or 403**) and *fails* on **404/500** — proving the route
  exists without depending on permission seeding. (Optionally seed Public `find` in `src/index.ts`
  bootstrap to get a clean 200; decide during implementation.) Documented as a script
  (e.g. `pnpm --filter adapter-strapi smoke`).

## 8. Exit criteria (from PLAN.md Phase 2)

- From an `Article` IR fixture, the programmatic `generate()` (+ `materialize`) produces a project
  that **boots and exposes the type** (verified by the gated boot smoke).
- **Golden files match byte-for-byte.**
- **Regen is idempotent** (second generate/materialize produces no diff).
- `pnpm -r typecheck` / `pnpm -r test` / `pnpm lint` green; per-commit CI green.

## 9. Cross-cutting

- Neutral IR vocabulary everywhere except inside `adapter-strapi`; all Strapi-isms (uid format,
  `richtext`/`biginteger` casing, `draftAndPublish`) are confined to the adapter.
- `adapter-strapi` depends on `adapter-kernel` + IR packages; never on sibling adapters (enforced
  by the Phase 1 ESLint boundary rules — extend them to the new packages).
- Determinism is load-bearing: stable ordering/formatting, no timestamps in output.
