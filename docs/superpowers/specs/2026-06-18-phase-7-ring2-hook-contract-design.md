# Phase 7 — Ring 2 Hook Contract Design

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 7
**Scope:** add named, typed Ring 2 hook/extension points to the IR, and have both the Strapi and
Filament adapters emit, per hook, a **typed contract** (generated/overwritten), a **protected
implementation stub** (`seed`, written once, hand-owned), and **invocation wiring** (generated) that
calls the implementation at the trigger. Prove the boundary with a local regen-preservation test and
reference implementations in the gated boot jobs. Phase 7 proves only the `onPublish` trigger
("on publish, transform a field").

---

## 1. Context & goal

Ring 2 is the typed escape hatch for real behavior — loops, side effects, host/DB/API calls —
which Ring 1 deliberately cannot express (ARCHITECTURE §1.2). Ring 2 is **not compiled**: the IR
declares a named, typed hook contract; the adapter emits that contract plus invocation wiring; the
behavior is hand-written in idiomatic PHP and TS in a **protected directory the generator never
touches** (ARCHITECTURE §1.3). This phase exercises the generated-vs-protected boundary the kernel
already provides (`FileMode: "overwrite" | "seed"` + the `TS_MARKER`), proving that regeneration
overwrites the derived contract/invocation while preserving the hand-written implementation.

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **`onPublish` trigger only**, behind a closed extensible `trigger` enum. | The exit criterion is "on publish, transform a field." More triggers are mechanical additions against the same machinery; this phase is about the contract + protected-region boundary, not trigger breadth. |
| D2 | **Typed named-field I/O shapes**, reusing the IR scalar field-type vocabulary. | A hook's `input`/`output` are lists of `{ name, type }` over IR scalars, compiling to a precise PHP interface (phpdoc array shapes) and a TS type — genuinely typed in both languages, neutral, golden-testable. |
| D3 | **Three emitted regions per hook:** contract (`overwrite` + marker), implementation stub (`seed`, protected, no marker), invocation wiring (`overwrite` + marker). | Maps directly onto the kernel's existing `FileMode`. The `seed` stub is written once and `materialize` skips it thereafter — the regen-preservation mechanism. No new kernel API. |
| D4 | **Hooks live in `irDocument.hooks?: Hook[]` (optional, default `[]`).** | Hooks are content-attached behavior, part of the content model. Optional ⇒ existing IR documents and ALL prior content goldens (6A/6B Filament, Strapi) stay byte-identical (no hooks → no hook files). |
| D5 | **Per-target invocation mechanism:** Strapi → the content type's `lifecycles.ts`; Filament → a generated Eloquent **Observer** (`#[ObservedBy]`). | The native, idiomatic publish-interception point in each target. The neutral `onPublish` maps to each; mechanics confined to the adapter. |
| D6 | **Local regen-preservation test is the decisive proof.** Materialize → edit the seed impl → materialize again → assert the edit survives while contract/invocation are regenerated. | Pure-fs, runs per-commit; directly proves "regen preserves the protected implementation untouched" without a booted app. |
| D7 | **Reference implementations run in the gated boot jobs.** Hand-implement the hook in the Strapi and Filament boot apps; assert "on publish" transforms the field. | The exit criterion's "hand-written implementations run" needs a real runtime; the gated boots are the oracle (as for permissions). |

## 3. IR hook model (`ir-schema/hooks.ts`)

```
Hook       = { name: <identifier>; trigger: "onPublish"; contentType: <typeName>;
               input: ShapeField[]; output: ShapeField[] }
ShapeField = { name: <fieldName>; type: HookScalar }
HookScalar = "string" | "text" | "integer" | "float" | "boolean" | "dateTime"
```

- `name` is a unique hook identifier (PascalCase-able for class names). `contentType` references an
  existing content type. `input`/`output` are non-empty typed field lists.
- Zod-validated; added to `irDocument` as optional `hooks` (default `[]`). A document-level refine
  checks each hook's `contentType` exists and hook `name`s are unique.
- `HookScalar` is a documented subset of the IR field types (no relations/media/json/enumeration in
  hook shapes for Phase 7 — scalar transforms only).

## 4. Emitted regions per hook (both adapters)

For a hook `H` on content type `C`:

1. **Contract** (`mode: "overwrite"`, `withMarker`):
   - **Strapi (TS)** `src/hooks/contracts/<name>.contract.ts` — an exported `interface <Name>Hook { run(input: <InputType>): <OutputType>; }` plus the `<InputType>`/`<OutputType>` object types from the shapes (IR scalar → TS type: string/number/boolean/string-for-dateTime).
   - **Filament (PHP)** `app/Hooks/Contracts/<Name>Hook.php` — `interface <Name>Hook { /** @param array{<field>: <phptype>, …} $input @return array{<field>: <phptype>, …} */ public function run(array $input): array; }` (IR scalar → PHP type: string/int/float/bool).

2. **Implementation stub** (`mode: "seed"`, protected, NO marker):
   - **Strapi** `src/hooks/<name>.ts` — `import type { <Name>Hook } …; export const <name>: <Name>Hook = { run(input) { /* TODO: implement */ return { … }; } };` (a typed stub returning the input passthrough/placeholder).
   - **Filament** `app/Hooks/<Name>.php` — `final class <Name> implements <Name>Hook { public function run(array $input): array { /* TODO: implement */ return $input; } }`.
   Written ONCE; `materialize` skips it on regen if it exists.

3. **Invocation wiring** (`mode: "overwrite"`, `withMarker`):
   - **Strapi** `src/api/<api>/content-types/<ct>/lifecycles.ts` — exports lifecycle handlers; on the
     publish transition (an update where the entry becomes published) it builds `input` from the
     record, calls the protected impl `<name>.run(input)`, and applies `output` back to the record.
   - **Filament** a generated `app/Observers/<Model>Observer.php` referenced by `#[ObservedBy(<Model>Observer::class)]` on the generated model; its `updated`/`saved` method detects the publish transition (status/`published_at`) and calls `App\Hooks\<Name>->run(input)`, applying `output`.

   (The exact publish-detection predicate per target is pinned in the plan and validated by the gated
   boot jobs; for Phase 7 the sample hook fires when the record transitions to published.)

The generated **model** (Filament) gains the `#[ObservedBy]` attribute only when the content type has
a hook — keeping hookless models byte-identical to 6A/6B.

## 5. The protected boundary (existing kernel mechanism)

- Contract + invocation: `mode: "overwrite"`, `withMarker(...)` (the `// @camis:generated` header).
- Impl stub: `mode: "seed"`, no marker. `materialize` (kernel) writes a `seed` file only if absent
  (`if seed && existsSync → continue`) and prunes only prior `overwrite` files — so the hand-edited
  impl is never overwritten or removed. No kernel changes; Phase 7 is the first real use of `seed`
  for protected hand-code.

## 6. Verification

- **Golden** (per target, sample hook `TransformTitle` `onPublish` on `Article`): the contract, the
  invocation wiring, and the seed stub — byte-exact.
- **Regen-preservation test** (per adapter, the decisive local proof): materialize the generated
  project to a temp dir; overwrite the seed impl file with a sentinel ("// HAND EDITED"); materialize
  the same result again; assert (a) the impl file still contains the sentinel (seed preserved), and
  (b) a contract file was rewritten (overwrite regenerated). Pure-fs, per-commit.
- **Reference impls run** (gated boot, both targets): the boot job overlays the generated project,
  replaces the seed stub with a real "uppercase the title on publish" implementation, boots,
  publishes a record, and asserts the title was transformed.

## 7. Packages & dependency direction

- `ir-schema` — `hooks.ts` (Hook/ShapeField schemas) + `irDocument.hooks`.
- `adapter-strapi` — a `hooks/` emission module (contract TS, lifecycles invocation, seed stub),
  wired into `generate`.
- `adapter-filament` — a `hooks/` emission module (contract PHP, observer invocation, seed stub),
  wired into `generate`; the model emitter conditionally adds `#[ObservedBy]`.
- `adapter-kernel` — unchanged (uses existing `FileMode`/`withMarker`/`materialize`).
- Adapters never import each other; the hook model is neutral (no target vocabulary); all
  lifecycle/observer/PHP/TS specifics confined to the owning adapter.

## 8. Testing

- **`ir-schema`:** Hook/ShapeField accept/reject (unknown `contentType`, duplicate hook names,
  non-scalar shape type, unknown trigger); `irDocument` with `hooks` validates; without `hooks`
  unchanged.
- **`adapter-strapi`/`adapter-filament`:** unit tests for the contract emitter (shape → typed
  interface), the invocation emitter, and the seed-stub emitter; golden for each region; the
  regen-preservation test; content goldens (no-hooks fixtures) byte-identical.
- **Gated boots:** extend both `*-boot` jobs with the reference-impl publish-transform assertion.

## 9. Exit criteria (from PLAN.md Phase 7)

- A sample hook (`onPublish`, transform a field) compiles its typed contract into BOTH targets;
  hand-written implementations run (gated boots); regeneration preserves the protected implementation
  untouched (local regen-preservation test green).
- Content goldens (no-hooks fixtures) byte-identical; `pnpm lint` / `pnpm -r typecheck` /
  `pnpm -r test` green.

## 10. Cross-cutting

- The IR is the single source of truth; the hook *contract* is neutral; behavior is hand-written
  per language (Ring 2 is not compiled). Reviewers reject any attempt to compile Ring 2 behavior
  from the IR.
- Generated vs protected is enforced by the kernel's `FileMode` + marker; the seed stub is the only
  protected (hand-owned) artifact; contract + invocation are regenerated each run.
- Determinism: contract/invocation/stub are deterministic (stable ordering, no timestamps), so
  goldens and idempotent regen hold; the seed stub is emitted identically on first generation.
