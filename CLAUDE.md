# CLAUDE.md — camis build conventions

Operating guide for the Claude Code session building **camis**. Read
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and [`docs/PLAN.md`](./docs/PLAN.md) before
writing any code. Follow `PLAN.md` phase order; do not start a phase until the previous
phase's exit criteria are green.

---

## Prime directives

1. **The IR is the single source of truth.** Target-specific concepts never leak into the IR
   or into shared packages — they live only inside the owning adapter.
2. **Respect the three rings (ARCHITECTURE §1.2).** Ring 1 is pure and total. If a feature
   needs a loop, assignment, side effect, or host/DB/API call, it is a **Ring 2 hook**, not a
   Ring 1 expression. Reject Ring-1 additions that breach purity/totality.
3. **One-way authoritative generation.** IR → targets. Import only from **declarative**
   sources (e.g. Strapi `schema.json`). Never parse generated PHP/TS code back into IR.
4. **Generated vs protected.** Generated regions are owned by the generator and overwritten on
   every run. Hand-written code (Ring 2 hooks, bespoke logic) lives only in protected
   directories the generator never touches. Never hand-edit a generated region.

---

## TDD — non-negotiable

- **Red → green → refactor**, in that order, visible in commit history. Write the failing
  test first; make it pass minimally; then refactor.
- No production code without a test that required it.
- **Codegen** is tested with **golden/snapshot files**: IR fixture → emitted artifact,
  byte-compared. Regeneration must be **idempotent** (second run = no diff).
- **Ring 1** is tested with **cross-runtime conformance vectors**: the same
  `expression + data → expected output` set runs through the TS evaluator *and* the emitted
  PHP. Divergence fails the build. This suite is the spine — treat it as load-bearing.
- A bug fix starts with a failing test reproducing the bug.
- Keep tests fast and isolated; no network in unit tests (AI/network behind interfaces, mocked).

---

## Separation of concerns

- **One package, one responsibility, one reason to change.** See ARCHITECTURE §2 for the map.
- **Dependency direction:** adapters depend on `adapter-kernel` + IR/`expr`/`permissions`
  packages. **Adapters never import sibling adapters.** Shared logic moves up into a shared
  package, not sideways.
- **No `any` across package boundaries.** Public APIs are fully typed. Internal `any` is a
  smell; at boundaries it's forbidden.
- **The PHP emitter is a TS package** that emits PHP *source*. It needs no PHP runtime to
  build — only to test the emitted output.

---

## Naming conventions

- **Neutral IR vocabulary everywhere** except inside the owning adapter. Say `contentType`,
  `field`, `relation`, `grant`, `predicate` — not `Resource`, `attribute::uid`,
  `__component`, `permission key`. Target terms are confined to their adapter.
- **TypeScript:** `PascalCase` types/classes, `camelCase` values/functions, `SCREAMING_SNAKE`
  consts. Files `kebab-case.ts`. One primary export concept per file.
- **Packages:** `@camis/<name>` matching the directory (`ir-schema`, `expr-ts`, …).
- **Tests:** `*.test.ts` beside source; golden fixtures under `__fixtures__/`,
  snapshots under `__golden__/`, conformance vectors in `expr` under a single canonical file.
- **PHP (emitted):** PSR-12; `PascalCase` classes, `camelCase` methods. Generated files carry
  a header marker identifying them as generated (for the marker/manifest system).
- **No abbreviations that aren't domain-standard.** `expression` not `expr` in identifiers
  (the *package* short name `expr` is fine; identifiers inside should be explicit).

---

## Clean code

- Small, single-purpose functions; clear names over comments.
- Comments explain **why**, never restate **what**.
- Errors are precise and located (which content type, which field, which rule).
- Determinism in codegen: stable ordering, stable formatting, no timestamps in output, so
  golden files and idempotent regen hold.
- No dead code, no speculative generality beyond the documented future-target seam.

---

## Tooling

- **Node:** pnpm workspace. `pnpm -r <script>` runs across packages.
- **TS:** strict mode on; no implicit `any`; `tsconfig.base.json` is the root of truth.
- **PHP:** **Composer**, owned inside each generated app under `apps/`. Wrap with pnpm
  scripts (`pnpm --filter <app> run …`) so the monorepo has one entry point.
- **Lint/format:** ESLint + Prettier (TS), PSR-12 (emitted PHP). Lint + test on commit.
- **CI:** install → lint → typecheck → test for every package; the `expr-php-emit` and
  Filament adapter test jobs additionally require PHP and the relevant databases.
- **Databases:** the Filament/Express targets must run on `sqlite | mysql | pgsql` selected
  purely by env var, with **no code change** between environments. CI exercises all three.

### Environment gotchas (this session's shell is zsh)

- **zsh does not word-split unquoted `$var`** — `for x in $list` iterates once with the whole
  string. Use a literal token list or `${=list}`.
- **`status` is a reserved read-only variable in zsh** — never use it as a variable name in
  scripts; pick `st`/`state`.
- **pnpm 10 blocks dependency build/postinstall scripts by default** — if a dep genuinely needs
  its postinstall (not esbuild, which ships its binary via an optional dep), allow it with
  `pnpm.onlyBuiltDependencies`, not by disabling the safety globally.

---

## Toolchain decisions (settled — do not re-litigate)

Concrete choices for this build. Each is binding until explicitly revisited; the *why* is the
point — it stops a future session from re-deciding or silently contradicting a settled call.

- **Test runner: Vitest** (not Jest) — ESM/TS-native, fast, first-class snapshots for golden
  tests. A root `vitest.workspace.ts` discovers all packages.
- **Modules: ESM** everywhere (`"type": "module"`, `"module": "ESNext"`,
  `"moduleResolution": "Bundler"`), including the PHP emitter — it emits PHP *source* as
  strings and runs on Node. Nothing is emitted; Vitest/tsx run the `src` `.ts` directly, so
  Bundler resolution (extensionless, can import `.ts`) fits — no `.js`-extension ceremony.
- **Internal packages consumed as `src`, no build step.** All packages are `private: true` and
  never published; each `exports` maps `"."` → `./src/index.ts`. Avoids stale-`dist` bugs.
- **No TS composite/project references** — they require an emit/build, which conflicts with
  src-consumption. Dependency direction is enforced two ways instead: **pnpm only resolves
  packages declared in `dependencies`**, and **ESLint boundary rules** (the three rings +
  no-sibling-import), added at the first real cross-package import and tightened from there.
- **Strict `tsconfig.base.json` beyond `strict`:** `noUncheckedIndexedAccess` (vital for IR
  walking), `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`,
  `isolatedModules`.
- **Determinism: `.gitattributes` `* text=auto eol=lf`** so byte-exact golden files are stable
  cross-OS.
- **Toolchain pinned:** `packageManager: "pnpm@10.13.1"` (corepack), Node 22 via
  `.nvmrc`/`engines`; `pnpm-lock.yaml` committed.
- **Git hooks:** lint-staged on **pre-commit** (fast, staged only); full `pnpm -r test` on
  **pre-push** — keeps red→green→refactor fast as the conformance suite grows.
- **CI: GitHub Actions** against `origin` (`github.com:hynding/camis`); per-concern jobs so the
  later PHP/DB jobs are additive. `gh` CLI is absent — use the **`github` MCP plugin** for
  PR/CI status.
- **`vendor/` excluded** from ESLint, Prettier, Vitest, and tsconfig `include` — it isn't ours
  to lint or test.
- **PHP tooling plugins installed:** `php-lsp` (emitted-PHP intelligence, from Phase 4),
  `laravel-boost` (Filament, Phase 6).

## Open decisions (resolve before the phase that needs them)

- **`apps/` bodies: committed vs git-ignored** — undecided (ARCHITECTURE §2). Shapes
  `.gitignore`; needed before **Phase 2**. Do not silently pick one — ask.

---

## Security & safety

- **Never embed API keys.** The Anthropic API used by `ai-authoring` has keys supplied by the
  environment; do not hardcode or log them.
- AI proposals are **validated against the IR schema before being written** — the validator is
  the guardrail; invalid proposals are rejected or repaired, never persisted.
- Generated permission code must enforce, not merely describe, the IR's grants — verify with
  tests that exercise denied paths, not just allowed ones.

---

## When unsure

- If a requested feature seems to need Ring 2 power inside Ring 1, **stop and reclassify** it
  as a hook; don't expand the expression grammar.
- If two adapters seem to need the same code, **lift it into a shared package**; don't
  cross-import.
- If a target can't represent an IR feature, **emit a capability-gap report entry**; don't
  silently drop it.
- Prefer adding a failing test that captures the question over guessing.
