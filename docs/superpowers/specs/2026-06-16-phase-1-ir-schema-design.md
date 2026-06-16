# Phase 1 — IR Schema & Core Design (`ir-schema`, `ir-core`)

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 1
**Scope:** the neutral content model exists, is typed, validates, and enforces its invariants.
Pure declarative data only — **no expressions, no permissions** (those are Phases 4 and 5).

---

## 1. Context & goal

Phase 1 produces the IR's single source of truth: the typed, validated, vendor-neutral
content model that every later adapter consumes. It must be trustworthy before any target is
built, so the test investment is in (a) a valid multi-type document round-tripping through
construction + validation, and (b) every malformed case failing with a precise, located error.

Per ARCHITECTURE §3 the IR models: content types (collection/single), the full field
taxonomy, components, relations, and per-type options. Capability-descriptor and
capability-gap-report **types** are defined here (no logic yet).

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Zod is the single source of truth.** Types via `z.infer`; runtime validation with path-located errors; JSON Schema generated later via `zod-to-json-schema` only when a consumer needs it. | One source — types and validator cannot drift. Bundle size irrelevant for a build-time tool. |
| D2 | **No standalone JSON Schema artifact in Phase 1.** | YAGNI; the Zod schema *is* the validator. |
| D3 | **Canonical `name` + optional overrides.** One neutral `name` is the referential key; `ir-core` derives plural/table/display via deterministic inflection; explicit overrides allowed. | Neutral, deterministic for golden files, faithful to Strapi's explicit names on round-trip (Phase 3). |
| D4 | **Unified located-error type** for both structural (Zod) and semantic (cross-graph) failures. | Satisfies CLAUDE.md's "which content type, which field, which rule"; one shape for fixture assertions. |
| D5 | **Relations allowed inside components** (and component-in-component nesting). | Strapi v5 permits relations in components; per Prime Directive, target limits (e.g. Strapi's one-way restriction) are **capability-gap** concerns in the adapter, not IR invariants. |
| D6 | **Dynamic zones only at content-type level** — enforced *by construction* (the component field union omits `dynamicZone`), not by a runtime check. | Confirmed by Strapi v5 and universally structural; making the illegal state unrepresentable beats validating against it. |
| D7 | **`Result` type over exceptions** for validation APIs. | Collect *all* errors; no throwing for expected validation failure. |
| D8 | **Hand-rolled deterministic inflection** (`s`/`es`/`ies`) + override escape hatch — no `pluralize` dep. | Keeps golden-file determinism fully in our control; irregulars use explicit overrides. |
| D9 | **Single-declaration relations.** One type owns the relation (`relationKind`, `target`, optional `inverse`). `inverse` present → bidirectional (the back-reference field is **synthesized** on the target, never separately declared); absent → unidirectional. `relationKind` is from the owner's perspective. | DRY, deterministic, no two-sided consistency invariant. Round-trip collapses Strapi's two-sided schema onto the owner (`inversedBy`) side, capturing the inverse name. |
| D10 | **Boundary by reachability:** every check decidable within a *single* content-type/component node lives in **ir-schema** (Zod + refinements); only checks needing the *document graph* live in **ir-core**. | Makes illegal states unrepresentable where possible; keeps `ir-core` small and its invariants genuinely cross-cutting. |
| D11 | **Typed closed `IrErrorCode` union** — no free-string codes. | Testable, fully-typed API per CLAUDE.md; fixtures assert on a known code set. |

## 3. Packages, responsibilities, dependency direction

```
@camis/ir-core  ──depends on──▶  @camis/ir-schema  ──(no deps)
```

### `@camis/ir-schema` — vocabulary + **node-local** validation
- Zod schemas: `IrDocument`, `ContentType`, `Component`, `Field` (discriminated union on
  `type`), the relation/component/dynamic-zone variants, options. A separate **`ComponentField`**
  union omits `dynamicZone` (D6).
- Public TS types via `z.infer`; `FieldType`, `RelationKind`, `IrErrorCode` unions.
- `parseDocument(input: unknown): Result<IrDocument>` — structural validation incl. all
  node-local refinements (§5); maps every `ZodIssue` into an `IrError` with a named location.
- `IrError`, `IrErrorCode`, `Result<T>` types.
- Capability-descriptor / capability-gap-report **types only** (no logic).

### `@camis/ir-core` — **cross-graph** semantics + normalization
- `normalize(doc: IrDocument): IrDocument` — fill option defaults, derive `names.*`,
  **preserve declared order**; **idempotent**.
- `validateInvariants(doc: IrDocument): IrError[]` — the cross-graph checks (§6.2).
- `validate(input: unknown): Result<IrDocument>` — `parseDocument` → `normalize` →
  `validateInvariants`; returns the normalized document or the full, ordered error list.
- Construction: plain typed object literals validated by `validate()`. Add a thin helper only
  if a test genuinely needs it — no fluent builder DSL (YAGNI).

## 4. IR shape

```ts
IrDocument { version: 1; contentTypes: ContentType[]; components: Component[] }

ContentType {
  name: string                         // canonical referential key, PascalCase singular: "Article"
  kind: "collection" | "single"
  names?: { plural?: string; display?: string; collection?: string }   // overrides; ir-core fills defaults
  fields: Field[]
  options?: { draftPublish?: boolean; timestamps?: boolean; softDelete?: boolean }
}

Component {
  name: string                         // canonical referential key, unique among components
  fields: ComponentField[]             // ComponentField = Field minus dynamicZone (D6)
}
```

## 5. Field taxonomy (discriminated union on `type`)

Common: `name` (camelCase). `default` is **typed per variant** (number for numerics, a `values`
member for enum, boolean for boolean, string for text). Neutral constraints only; richer ones
(regex, composite-unique) deferred until an adapter needs them.

- **Text-ish** `string | text | richText | email | uid`:
  `required? unique?(string/uid) minLength? maxLength? default?`; `uid` adds `targetField?`
  (a sibling field name; see S10).
- **Numeric** `integer | bigInteger | float | decimal`: `required? unique? min? max? default?`.
- **`enumeration`**: `values: string[]` (≥1), `required? default?`.
- **`boolean`**: `required? default?`.
- **Temporal** `date | time | dateTime | timestamp`: `required? default?`.
- **`json`**: `required?` (no `default`).
- **`media`**: `required? multiple?: boolean; allowedTypes?: ("image"|"video"|"audio"|"file")[]` (no `default`).
- **`relation`** (D9): `relationKind: "oneToOne"|"oneToMany"|"manyToOne"|"manyToMany"; target: <contentTypeName>; inverse?: <fieldName>`.
- **`component`**: `component: <componentName>; repeatable: boolean; required?`.
- **`dynamicZone`** (content-type level only): `components: <componentName>[]` (≥1); `required?`.

## 6. Validation rules — each gets ≥1 test (exit criterion)

### 6.1 Node-local → **ir-schema** (Zod + `.refine`)
- **S1 identifier patterns** — type/component `name`: `^[A-Z][A-Za-z0-9]*$`; field `name`: `^[a-z][A-Za-z0-9]*$`.
- **S2** enum `values` non-empty.
- **S3** `min ≤ max` and `minLength ≤ maxLength`.
- **S4** enum `default ∈ values`.
- **S5** no duplicate field `name` within one type/component.
- **S6** `dynamicZone` not constructible inside a component (by union type — D6).
- **S7** `dynamicZone.components` non-empty.
- **S8** reserved field name `id` disallowed (universal; target-specific reserved names → capability gaps).
- **S9** `default` matches its field variant's type.
- **S10** `uid.targetField`, if present, names another field **in the same node**.

### 6.2 Cross-graph → **ir-core** (`validateInvariants`)
- **C1** relation `target` resolves to an existing content type (**self-reference allowed**).
- **C2** `component` / `dynamicZone` component refs resolve to existing components.
- **C3** global uniqueness — content-type `name`s unique; component `name`s unique.
- **C4** component reference graph is **acyclic**.
- **C5** `relation.inverse`, if present, does **not** collide with an existing field name on the target type.

## 7. Error model & control flow

```ts
type IrErrorCode =
  | "invalid_document" | "invalid_identifier" | "empty_enumeration" | "invalid_min_max"
  | "enum_default_not_member" | "duplicate_field" | "empty_dynamic_zone" | "reserved_field_name"
  | "invalid_default_type" | "unknown_uid_target"            // node-local (ir-schema)
  | "unknown_relation_target" | "unknown_component_ref" | "duplicate_content_type_name"
  | "duplicate_component_name" | "cyclic_component_reference" | "inverse_field_collision";  // cross-graph (ir-core)

interface IrError {
  code: IrErrorCode
  message: string                                   // precise, human-readable
  location: { contentType?: string; component?: string; field?: string; rule?: string }
  path: (string | number)[]                         // machine path (Zod issue path or graph path)
}

type Result<T> = { ok: true; value: T } | { ok: false; errors: IrError[] }
```
- Validation **never throws** for invalid input — returns `{ ok: false, errors }` with **all**
  errors collected. Programmer misuse may throw.
- Zod index paths (`contentTypes.2.fields.0`) are translated into named locations
  (`{ contentType: "Article", field: "slug" }`).
- **Errors are emitted in deterministic order**: document order (depth-first), then `code` —
  so malformed-fixture assertions are stable.

## 8. Normalization (`normalize`) — determinism contract

- Fills `options` defaults; derives, when absent (explicit overrides always win):
  - `names.display` — humanized, title-cased from `name` (`BlogPost` → "Blog Post").
  - `names.plural` — pluralized canonical (`Article` → `Articles`).
  - `names.collection` — snake_case pluralized DB-table form (`BlogPost` → `blog_posts`).
  - For `single` types, `plural`/`collection` are still derived but adapters may ignore them.
- **Preserves declared field and type order** (determinism = same input → same output).
- **Idempotent:** `normalize(normalize(x))` deep-equals `normalize(x)` — a required test.

## 9. Capability model (types only this phase)

```ts
CapabilityDescriptor {
  target: string
  fieldTypes: Partial<Record<FieldType, boolean>>
  relationKinds: Partial<Record<RelationKind, boolean>>
  features: Partial<Record<"dynamicZone"|"component"|"softDelete"|"draftPublish"|"media", boolean>>
}
CapabilityGap { feature: string; location: IrError["location"]; severity: "error" | "downgrade"; message: string }
CapabilityGapReport { target: string; gaps: CapabilityGap[] }
```
No logic — adapters populate these from Phase 5 onward.

## 10. Testing strategy (TDD, red→green→refactor)

- `*.test.ts` beside source; fixtures under `__fixtures__/`.
- **Valid path:** one multi-type fixture with a relation *and* a component (incl. a self-relation)
  → constructs, normalizes, validates clean (the exit-criteria happy path).
- **Malformed path:** one fixture per rule in §6 (S1–S10, C1–C5) plus key Zod structural
  failures, each asserting the expected `IrError.code` and `location`.
- **Determinism:** `normalize` idempotency test; stable error-ordering test.
- ≥1 test per invariant (exit criterion).

## 11. Out of scope (explicit)

- Expressions / Ring 1 (Phase 4), permissions (Phase 5), any target emission (Phase 2+).
- JSON Schema artifact (D2), capability-gap *logic* (Phase 5+), AI primitives (Phase 9).
- Target-specific naming/representability/reserved-name rules — surfaced later via the
  capability-gap report, never as IR invariants.

## 12. Exit criteria (from PLAN.md Phase 1)

- Construct a valid multi-type IR (with a relation and a component) in tests.
- Each malformed IR fixture fails with the expected error.
- ≥1 invariant test per invariant.
- `pnpm -r typecheck` / `pnpm -r test` / `pnpm lint` green; CI green.
