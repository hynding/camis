# Phase 5 — Permissions Model + Strapi Admin RBAC Emission (`permissions`, `adapter-strapi`)

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 5
**Scope:** build the neutral, superset permission model (roles → per-type grants → optional
field-level rules → optional condition rules, all built on Ring-1 predicates) and its first
down-projection: emit Strapi v5 **admin RBAC** roles/permissions, with field-level and condition
rules native, condition predicates compiled to TypeScript handlers via Ring-1's `emitTs`, and the
capability-gap report wired in.

---

## 1. Context & goal

Permissions are "the hardest mapping" (ARCHITECTURE §4): target models overlap but are not
isomorphic. The IR holds the **superset**; each adapter **down-projects** and reports anything it
cannot express. Phase 5 establishes the neutral model and proves the first projection against
Strapi — which, being Node, is also the first time **Ring-1 compiles into a real generated
project** (`emitTs` → registered Strapi condition handlers). The load-bearing guarantee carried
forward: a generated condition's logic equals the canonical Ring-1 result (the conformance spine).

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Target Strapi admin RBAC** (content-manager permissions), not the users-permissions plugin. | Admin RBAC is the only Strapi system with **native field-level** (`properties.fields`) **and conditions**; required for the "empty gap" exit criterion. Users-permissions (API roles) lacks both. |
| D2 | **Model lives in `permissions`**, passed to generation **alongside** the document as an `IrBundle = { document, roles }` — roles are NOT embedded in `irDocument`. | Keeps the model in its package (ARCHITECTURE §2) and avoids an `ir-schema ↔ permissions` dependency cycle. |
| D3 | **`permissions` is emission-agnostic.** It depends on `expr` (predicate schema) + `ir-schema` (identifiers) + `ir-core` (`Result`). It does NOT depend on `expr-ts`. All `emitTs`/runtime-source concerns live in `adapter-strapi`. | One package, one responsibility: the model is neutral; emission is the adapter's job. |
| D4 | **Condition predicates compile to TypeScript** via `emitTs` (Strapi runs on Node). The generated standalone project needs the runtime `r` as a file, so `expr-ts` exposes `tsRuntimeSource()` that returns its own `runtime.ts` content (single source of truth — no duplication; generated conditions use the exact `r` the conformance suite tests). | Preserves the cross-runtime conformance spine by construction; the TS analog of `PHP_RUNTIME`. |
| D5 | **Fail-closed enforcement.** A generated condition handler returns `true` **iff** the Ring-1 result is `{ ok: true, value: true }`; any eval-error or non-boolean → **deny**. Predicates are total, so this is always defined. | Security default: deny on uncertainty. Generated permission code must *enforce*, not merely describe. |
| D6 | **Documented predicate context = `user.*`** (boolean-from-user conditions). Handlers inject a flat `data` map of `user.*` keys; any absent var → `UNKNOWN_VAR` → deny (D5). **Row-level / query-object conditions are out of scope** (future work). | Strapi enforces record-level rules via query objects, not per-row JS booleans; matching that is a separate compiler. Keeps Phase 5 bounded. |
| D7 | **Honest gaps via `freeVars`.** Add a pure `freeVars(expression): string[]` to `expr`. The adapter emits a capability-gap (`downgrade`) for any condition/field-rule predicate referencing variables outside the documented `user.*` context — never a silent always-deny. | "Emit a capability-gap entry; don't silently drop." Avoids the footgun of a record-level predicate that would always deny. |
| D8 | **Reference validation, not var-typing.** `validateBundle(bundle): Result` cross-checks that each `grant.contentType` exists in the document and each `fieldRule.field` exists on it. Semantic var-name *typing* against field types stays **deferred** (mirrors Phase 4 D8). | Catches structural reference errors now; defers the heavier semantic layer. |
| D9 | **Determinism.** Conditions are named by a short stable hash of the predicate's canonical JSON (`stableJson` → digest), deduping identical predicates. Every emitted collection (roles, grants, actions, `fields`, `conditions`) is sorted by a stable key. No timestamps. | Golden-stable, idempotent regeneration. |
| D10 | **Verification = golden + structural + Ring-1 tie-in** (no booted Strapi this phase). The action-UID map is isolated in one constant and golden-locked. | Matches the generation-focused exit criteria; a booted-enforcement smoke is deferred (the Phase 2 gated pattern remains available later). |

## 3. The permission model (`permissions`, Zod-validated)

```
Action    = "create" | "read" | "update" | "delete" | "publish"
FieldRule = { field: <fieldName>; access: "read" | "write"; when?: Expression }   // when absent ⇒ always
Grant     = { contentType: <typeName>; actions: Action[] (≥1); fieldRules?: FieldRule[]; condition?: Expression }
Role      = { name: string; description?: string; grants: Grant[] }
IrBundle  = { document: IrDocument; roles: Role[] }
```

- Predicates (`when`, `condition`) are validated by `expr`'s **closed** `expression` schema, so
  purity/totality is inherited; a Ring-2 construct cannot appear in a permission rule.
- `actions` has `.min(1)`; `grants` may be empty (a role with no grants is valid but inert).
- `IrBundle.roles` defaults to `[]`, so a content-only bundle emits **no** permission artifacts
  and existing Phase 2/3 golden output is byte-identical.
- **`validateBundle(bundle): Result<IrBundle>`** (in `permissions`, using `ir-core`'s
  `Result`/`fail`/`ok`): located errors for unknown `contentType` / unknown `field` references.
  Generation assumes a valid bundle (as it already assumes a valid `IrDocument`); validation is a
  separate gate (adapter/CLI call it first).

## 4. `expr` additions

- **`freeVars(expr: Expression): string[]`** — pure, total AST walk returning the distinct `var`
  names referenced (sorted, deduped). Used by the adapter for D7 gap detection. Belongs in `expr`
  (operates only on the AST; reusable by every Node target).

## 5. `expr-ts` additions

- **`tsRuntimeSource(): string`** — returns the exact source of `expr-ts`'s `runtime.ts` (read
  from disk at call time; the file is the single source of truth). The adapter writes this
  verbatim into the generated project so its conditions use the same `r` the conformance vectors
  validate. A test executes the returned source and runs a conformance vector through the
  resulting `r` to prove it is runnable and correct.

## 6. Generation input change (the one migration)

- `adapter-kernel` `GenerateAdapter.generate(ir: IrBundle, options)` (was `generate(doc: IrDocument, …)`).
  `IrBundle` is imported from `permissions` (`kernel → permissions → ir-schema/expr/ir-core`; no
  cycle — `kernel → ir-schema` already exists).
- **Migration touch-points** (mechanical): `strapiAdapter.generate` reads `ir.document` /
  `ir.roles`; every existing caller/test/fixture wraps its document as `{ document, roles: [] }`;
  the round-trip import test (`importDocument(generate(...).files)`) is unaffected because import
  reads only declarative content-type/component schema files and `roles: []` emits none. Check the
  `cli` package for a generate call site and update it.

## 7. Strapi down-projection (`adapter-strapi/src/permissions/`)

Emitted artifacts (only when `roles` is non-empty):

1. **`src/permissions/roles.json`** — deterministic seed data. Per role:
   `{ name, description?, permissions: PermissionEntry[] }` where
   `PermissionEntry = { action: <content-manager action uid>, subject: "api::<singular>.<singular>", properties?: { fields: string[] }, conditions?: string[] }`.
   Sorted: roles by `name`, permissions by `(action, subject)`, `fields`/`conditions` lexically.

2. **`src/permissions/conditions.ts`** — one Strapi condition per **distinct** predicate:
   `{ displayName, name: "camis-cond-<hash8>", plugin: "admin", handler }`. `handler(user)` builds
   the documented `user.*` `data` map, evaluates the emitted Ring-1 expression (`emitTs` output)
   against the runtime `r`, and returns the **fail-closed** boolean (D5). Imports `r` from the
   emitted runtime file (§8).

3. **`src/permissions/ring1-runtime.ts`** — `tsRuntimeSource()` written verbatim (only when at
   least one condition is emitted).

4. **`src/index.ts` bootstrap** — extended to `conditionProvider.registerMany(conditions)` and to
   idempotently upsert roles/permissions from `roles.json` (upsert key: role by `name`; permission
   by its full identity). Generated/overwrite region.

### 7.1 Action-UID map (isolated, drift-prone)

A single `src/permissions/actions.ts` constant maps IR `Action` → Strapi content-manager action
uid (`create`→`plugin::content-manager.explorer.create`, `read`→`…read`, `update`→`…update`,
`delete`→`…delete`, `publish`→`…publish`). Exact uids pinned against Strapi v5 in the plan and
golden-locked. This is the fact a future boot smoke would most likely catch drifting.

### 7.2 Field-level & condition mapping

- `access:"read"` → the read action; `access:"write"` → the create and update actions.
- Field rule **without** `when` → its field joins that action's `properties.fields`.
- Field rule **with** `when` → a **separate** permission entry: `properties.fields:[field]` +
  `conditions:["camis-cond-<hash>"]`.
- Grant-level `condition` → `conditions:[…]` on the grant's base permission entries.
- All native admin RBAC ⇒ **empty gap** for a fixture whose predicates use only `user.*`.

### 7.3 Capability gaps

Reuse `CapabilityGapReport` (target `"strapi"`). Emitted (all `downgrade`, located):
- a condition/field-rule predicate whose `freeVars` escape the `user.*` context (D7);
- `publish` granted on a content type without `draftPublish`.
The recommended fixture triggers none → empty report.

## 8. Dependency direction (summary)

```
permissions → expr, ir-schema, ir-core
adapter-kernel → ir-schema, permissions            (IrBundle in the generate contract)
adapter-strapi → adapter-kernel, ir-schema, ir-core, permissions, expr, expr-ts
expr → (leaf; + freeVars)        expr-ts → expr (+ tsRuntimeSource)
```
No cycles. ESLint boundary update: allow `adapter-strapi → @camis/permissions` and
`adapter-strapi → @camis/expr-ts`/`@camis/expr` (adapters may import shared model/expr packages;
the existing rule only forbids *sibling adapters*). Confirm the kernel rule permits
`adapter-kernel → permissions`.

## 9. Testing

- **`expr`:** `freeVars` over representative nodes (nested, dedup, sorted; literal-only ⇒ `[]`).
- **`expr-ts`:** `tsRuntimeSource()` returns runnable source — execute it and run a conformance
  vector through the produced `r`; assert byte-stability (same string across calls).
- **`permissions`:** Zod accept/reject (predicate closedness via `expr`; `actions ≥ 1`);
  `validateBundle` rejects unknown content-type and unknown field references with located errors;
  accepts a valid role carrying a field rule + a condition.
- **`adapter-strapi`:**
  - **Golden** (`__golden__/`): `roles.json`, `conditions.ts`, `ring1-runtime.ts`, and the
    bootstrap `index.ts` — byte-exact — for a fixture role with **both** a field-level rule and a
    condition rule (predicates over `user.*`).
  - **Structural:** conditions deduped by predicate; stable `camis-cond-<hash>` names;
    field/condition mapping (§7.2) produces the expected permission entries.
  - **Ring-1 tie-in:** for the fixture's predicate, `new Function("r","data","return "+emitTs(pred))(r, data)`
    equals `evaluate(pred, data)`; and the fail-closed wrapper maps `{ok:true,value:true}`→`true`,
    everything else→`false`. Reuses Phase 4 machinery — proves the generated Strapi condition logic
    matches canonical Ring-1 semantics.
  - **Gaps:** empty for the recommended fixture; populated for a `record.*`-referencing predicate
    and for `publish` on a non-`draftPublish` type.
  - **Idempotent regen:** second `generate` over the same bundle = no diff (kernel-enforced;
    permission files included).
- **Migration:** existing content-only goldens unchanged under `{ document, roles: [] }`.

## 10. Exit criteria (from PLAN.md Phase 5)

- An IR with a role carrying a **field-level rule and a condition rule** generates correct Strapi
  admin-RBAC permissions; the capability-gap report is **empty** for Strapi on that fixture.
- `pnpm lint` / `pnpm -r typecheck` / `pnpm -r test` green; per-commit CI green.

## 11. Cross-cutting

- The IR is the single source of truth; `permissions` is neutral (no Strapi vocabulary). All
  Strapi-isms (action uids, `properties.fields`, `conditions`, `plugin:"admin"`, the
  `conditionProvider` bootstrap) are confined to `adapter-strapi`.
- Ring-1 closure/totality carries into permissions: predicates are validated by the closed schema;
  generated handlers are total and fail-closed.
- Determinism (D9) keeps golden files and idempotent regeneration stable.
- One-way authoritative generation: roles/permissions are emitted from the IR; nothing parses
  generated permission code back into IR (import of permissions is out of scope — declarative
  Strapi role/permission state lives in the DB, not in declarative schema files).
