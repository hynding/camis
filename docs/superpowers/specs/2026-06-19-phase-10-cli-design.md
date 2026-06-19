# Phase 10 — CLI & DX polish (`@camis/cli`) Design

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 10 (final).
**Scope:** build `@camis/cli` — one ergonomic entry point that composes the existing packages into
`camis validate | import | generate | build`, driven by a JSON project config that selects target(s)
and output dirs. The CLI adds **no new IR or codegen logic**; it is wiring + UX over `ir-core`
`validate`, the three `GenerateAdapter`s, the adapter importers, and kernel `materialize`.

---

## 1. Context & goal

Everything camis does already exists as composable packages. Phase 10 gives them one operable surface:
read an IR, validate it, import a declarative source into IR, preview a generation, and build a target's
project to disk — selected by a `camis.config.json`. The exit criterion: **a single JSON config builds a
chosen target end-to-end via the CLI.** The CLI preserves the prime directives — IR is the single source
of truth, one-way authoritative generation, import only from declarative sources.

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **`generate` = dry-run (no disk writes); `build` = generate + `materialize` to `out`.** | A safe preview vs the effectful write; `generate` is trivially testable; `build` is the end-to-end deliverable. |
| D2 | **A `GenerateAdapter` target registry** maps a target name → adapter (Express via `expressAdapterFor(dialect)`; Strapi/Filament singletons). | All three share the `GenerateAdapter` interface; the registry is the single place that knows the adapter set. |
| D3 | **Hand-rolled arg parsing — no CLI-framework dependency.** | Four commands; the monorepo avoids unnecessary deps + pnpm build-script surface. |
| D4 | **Commands are functions over an injected `io` seam** (`readFile`/`writeFile`/`mkdir`, `materialize`, a `stdout` writer, the registry); a tiny `bin.ts` wires the real `process`/`fs`. | No real process/network/fs in unit tests; `bin.ts` is the only un-unit-tested file. |
| D5 | **`camis.config.json` is Zod-validated**: `{ ir, targets: [{ target, out, projectName?, dialect? }] }`; `dialect` is Express-only. | Located config errors; the same guardrail discipline as the IR. |
| D6 | **Exit codes:** invalid IR / unknown command / `error`-severity gap ⇒ non-zero; `downgrade` gaps are warnings (exit stays 0, `build` still writes). | A target that cannot represent something essential should fail loudly; a downgrade is informational. |

## 3. Architecture & command surface

`@camis/cli` exports `run(argv: string[], io: Io): Promise<number>` (the exit code). The four commands:

- **`camis validate <ir.json>`** — load the IR JSON, run `validate`; print `✓ valid (N content types)`
  (exit 0) or each `IrError` as `✗ [code] <location> — <message>` (exit 1).
- **`camis import <target> <projectDir> [--out ir.json]`** — read a **declarative** source via that
  adapter's importer → `Result<IrDocument>`; on `ok`, `validate`, `stableJson`, write `--out` (default
  `./camis.json`), print `✓ imported → <out>`. The two importers have **different shapes** the command
  normalizes: Strapi is `await readStrapiProject(projectDir)` (async; reads the project's `schema.json`
  files itself); Express is `importExpressProject([{ path: "camis.schema.json", content }])` (sync; the
  command reads `<projectDir>/camis.schema.json` and passes it as a one-file set). Both yield
  `{ document: Result<IrDocument> }`. `filament`/unknown → exit 1 ("no importer; generation is one-way").
- **`camis generate [--config camis.config.json]`** — load config + IR, `validate` (fail-fast, exit 1 if
  invalid); for each target run `adapter.generate` and print `<target>: N files → <out> (dry-run)` plus
  the gap report. **No disk writes.**
- **`camis build [--config camis.config.json]`** — same, then `await materialize(result, out)` per target;
  print `<target>: wrote N files → <out>`. An `error`-severity gap aborts that target's write.

**Files:** `config.ts` (schema + loader), `registry.ts` (target → adapter), `io.ts` (the `Io` seam type),
`commands/validate.ts`, `commands/import.ts`, `commands/generate.ts`, `commands/build.ts`, `run.ts`
(dispatch), `bin.ts` (real-IO entry), `index.ts` (exports `run` + types).

## 4. Project config + target registry

`camis.config.json` (Zod schema in `config.ts`):

```jsonc
{
  "ir": "./camis.json",
  "targets": [
    { "target": "express", "dialect": "sqlite", "out": "./generated/api" },
    { "target": "strapi",  "out": "./generated/cms",  "projectName": "blog" },
    { "target": "filament", "out": "./generated/admin" }
  ]
}
```

- `ir` and each `out` resolve **relative to the config file's directory**.
- Each target: `target` (enum `express|strapi|filament`), `out` (string), `projectName?` (default derived
  from the `out` basename), `dialect?` (`sqlite|mysql|pgsql`, Express only, default `sqlite`).
- Unknown keys are stripped; bad enums / missing `out` fail the Zod parse → a located config error.

`registry.ts`:

```ts
export const adapterFor = (t: TargetConfig): GenerateAdapter =>
  t.target === "express" ? expressAdapterFor(t.dialect ?? "sqlite")
  : t.target === "strapi" ? strapiAdapter
  : filamentAdapter;
```

All targets then invoke uniformly: `adapter.generate({ document, roles: [] }, { projectName })`. (The IR
JSON is a content model; `roles` defaults to `[]` unless the IR file carries a bundle — see §6.)

## 5. Gap output & exit codes

For each target, group `result.gaps.gaps` and print each as `⚠ <feature> @ <contentType>[.<field>] —
<message>`. **Exit code:** any gap with `severity: "error"` ⇒ non-zero (and, in `build`, that target's
write is aborted); `downgrade` gaps are warnings (exit stays 0; `build` still writes). No current adapter
emits an `error`-severity gap (every real gap is a `downgrade`), so this abort path is **defensive** and
is covered by a test using a **stub `GenerateAdapter`** that emits an `error` gap — not left as untested
dead code. A per-target
failure (invalid IR, error-gap) sets a non-zero overall exit but does not suppress reporting the other
targets. `validate` and `import` failures exit 1.

## 6. IR input shape

The `ir` file is a serialized **IrDocument** (the content model). The CLI wraps it as the bundle the
adapters expect: `{ document, roles: [] }`. (Permissions/roles authoring through the CLI is out of scope
for Phase 10 — roles default to empty; a project that needs roles supplies them programmatically. This
keeps the CLI focused on the content-model build path the exit criteria require.)

## 7. Testing

Commands are functions over the injected `Io`, asserting on captured stdout + an in-memory/temp fs:
- **`config.ts`** — parses a valid config; rejects an unknown target, a bad `dialect`, a missing `out`;
  `ir`/`out` resolve relative to the config directory.
- **`registry.ts`** — each name returns an adapter whose `.target` matches; Express honors `dialect`.
- **`validate`** — a valid IR fixture → exit 0 + `✓`; an invariant-violating IR → exit 1 + the located
  error.
- **`import`** — a Strapi `schema.json` fixture project → an IR JSON written to the fake fs; `filament` →
  exit 1.
- **`generate`** — a config + IR → asserts the printed file count + a gap line AND that the fake
  `writeFile`/`materialize` recorded **zero** calls.
- **`build`** — materializes into a **temp dir**; asserts the expected files exist on disk + the gap
  report printed.
- **`run.ts`** — unknown command → usage + exit 1; `--config` resolution; arg parsing.
- **Exit-criteria test:** a single `camis.config.json` + IR → `build` one target → files land in the temp
  dir and re-reading proves a coherent project.

`bin.ts` (real `process.argv` + node `fs` + kernel `materialize`) is the only file not unit-tested.

## 8. Exit criteria (Phase 10 — closes the build)

- A single `camis.config.json` builds a chosen target end-to-end via `camis build` (a coherent project
  written to `out`).
- `validate` / `import` / `generate` work with clear, located output and correct exit codes; capability
  gaps are reported.
- Docs updated: a `packages/cli/README.md` (commands + sample config) and a "Using the CLI" pointer in the
  repo `README.md`.
- `pnpm lint` / `pnpm -r typecheck` / `pnpm -r test` green.

## 9. Cross-cutting

- The CLI adds **no IR/codegen logic** — it composes `validate`, the three `GenerateAdapter`s, the
  importers, and `materialize`. The IR stays the single source of truth; one-way authoritative generation
  is preserved (import only from declarative sources; Filament has no importer).
- No new runtime dependencies (hand-rolled arg parsing). `bin` runs via `tsx` per the repo's
  consumed-as-src convention.
- Determinism: `build` reuses `materialize` unchanged (markers/manifest, seed-file protection).
- No new Ring-1/Ring-2 surface.
