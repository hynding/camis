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
| D2 | **No standalone JSON Schema artifact in Phase 1.** | YAGNI; the Zod schema *is* the validator. Add the `.json` emission when a real external/declarative consumer exists. |
| D3 | **Canonical `name` + optional overrides.** One neutral `name` is the referential key; `ir-core` derives plural/table/display via deterministic inflection; explicit overrides allowed. | Neutral, deterministic for golden files, faithful to Strapi's explicit singular/plural on round-trip (Phase 3). |
| D4 | **Unified located-error type** for both structural (Zod) and semantic (invariant) failures. | Satisfies CLAUDE.md's "which content type, which field, which rule"; one shape for fixture assertions. |
| D5 | **Relations allowed inside components** (and component-in-component nesting). | Strapi v5 permits relations in components; per Prime Directive, target limits (e.g. Strapi's one-way restriction) are **capability-gap** concerns in the adapter, not IR invariants. |
| D6 | **Dynamic zones only at content-type level** (never inside components). | Confirmed by Strapi v5 docs and universally structural — a polymorphic zone is not a well-defined member of a reusable component in any target. |
| D7 | **`Result` type over exceptions** for validation APIs. | Collect *all* errors; no throwing for expected validation failure. Throw only on programmer misuse. |
| D8 | **Hand-rolled deterministic inflection** (`s`/`es`/`ies`) + override escape hatch — no `pluralize` dep. | Keeps golden-file determinism fully in our control; irregulars use explicit overrides. |

## 3. Packages, responsibilities, dependency direction

```
@camis/ir-core  ──depends on──▶  @camis/ir-schema  ──(no deps)
```

### `@camis/ir-schema` — vocabulary + structural validation
- Zod schemas: `IrDocument`, `ContentType`, `Component`, `Field` (discriminated union on
  `type`), relation/component/dynamic-zone field variants, options.
- Public TS types via `z.infer`.
- `parseDocument(input: unknown): Result<IrDocument>` — structural validation; maps every
  `ZodIssue` into a unified `IrError` (translating index paths to named locations).
- `IrError` type + `Result<T>` type.
- Capability-descriptor / capability-gap-report **types only** (no logic).

### `@camis/ir-core` — semantics: construction, normalization, invariants
- Construction helpers (ergonomic builders for tests/authoring).
- `normalize(doc: IrDocument): IrDocument` — fill option defaults, derive name forms
  (plural/table/display), **preserve declared field order**; **idempotent**.
- `validateInvariants(doc: IrDocument): IrError[]` — referential/structural checks (§6).
- `validate(input: unknown): Result<IrDocument>` — orchestrates: `parseDocument` → `normalize`
  → `validateInvariants`; returns the normalized document or the full error list.

## 4. IR shape

```ts
IrDocument {
  version: 1
  contentTypes: ContentType[]
  components: Component[]
}

ContentType {
  name: string                         // canonical referential key, e.g. "Article" (PascalCase singular)
  kind: "collection" | "single"
  names?: { plural?: string; display?: string; collection?: string }   // overrides; ir-core fills defaults
  fields: Field[]
  options?: { draftPublish?: boolean; timestamps?: boolean; softDelete?: boolean }
}

Component {
  name: string                         // canonical referential key, unique among components
  fields: Field[]                      // may include relation + nested component; NOT dynamicZone
}
```

## 5. Field taxonomy (discriminated union on `type`)

Common to every field: `name` (camelCase attribute key) + type-specific props below. Neutral
constraints only; richer constraints (regex, composite-unique) deferred to when an adapter
needs them.

- **Text-ish** `string | text | richText | email | uid`:
  `required? unique?(string/uid) minLength? maxLength? default?`; `uid` adds `targetField?`.
- **Numeric** `integer | bigInteger | float | decimal`: `required? unique? min? max? default?`.
- **`enumeration`**: `values: string[]` (≥1), `required? default?`.
- **`boolean`**: `required? default?`.
- **Temporal** `date | time | dateTime | timestamp`: `required? default?`.
- **`json`**: `required? default?`.
- **`media`**: `required? multiple?: boolean; allowedTypes?: ("image"|"video"|"audio"|"file")[]`.
- **`relation`**: `relationKind: "oneToOne"|"oneToMany"|"manyToOne"|"manyToMany"; target: <contentTypeName>; inverse?: <fieldName>`.
- **`component`**: `component: <componentName>; repeatable: boolean; required?`.
- **`dynamicZone`**: `components: <componentName>[]` (≥1); `required?`. (Content-type level only — D6.)

## 6. Invariants (`validateInvariants`) — each gets ≥1 test

1. **relation target resolves** — `relation.target` names an existing content type.
2. **component/dynamic-zone refs resolve** — referenced components exist.
3. **no duplicate field names** within a single type or component.
4. **unique names** — content-type `name`s unique; component `name`s unique.
5. **enumeration non-empty** — `values.length >= 1`.
6. **dynamic-zone placement** — `dynamicZone` only at content-type level, never in a component.
7. **no cyclic component references** — component nesting graph is acyclic.

## 7. Error model & control flow

```ts
IrError {
  code: string            // e.g. "unknown_relation_target", "duplicate_field", "invalid_type"
  message: string         // precise, human-readable
  location: { contentType?: string; component?: string; field?: string; rule?: string }
  path: (string | number)[]   // machine path (Zod issue path or builder path)
}

type Result<T> = { ok: true; value: T } | { ok: false; errors: IrError[] }
```

- Validation **never throws** for invalid input — it returns `{ ok: false, errors }` with *all*
  errors collected. Programmer misuse (e.g. builder called with impossible args) may throw.
- Zod's index paths (`contentTypes.2.fields.0`) are translated into named locations
  (`{ contentType: "Article", field: "slug" }`) during the `ZodIssue → IrError` mapping.

## 8. Normalization (`normalize`) — determinism contract

- Fills `options` defaults and derives `names.plural/display/collection` when absent, using the
  hand-rolled inflector (D8); explicit overrides win.
- **Preserves declared field and type order** (determinism = same input → same output; no
  reordering of author intent).
- **Idempotent:** `normalize(normalize(x))` deep-equals `normalize(x)` — a required test.

## 9. Capability model (types only this phase)

```ts
CapabilityDescriptor {
  target: string
  fieldTypes: Partial<Record<FieldType, boolean>>
  relationKinds: Partial<Record<RelationKind, boolean>>
  features: Partial<Record<"dynamicZone"|"component"|"softDelete"|"draftPublish"|"media", boolean>>
}
CapabilityGap {
  feature: string
  location: IrError["location"]
  severity: "error" | "downgrade"
  message: string
}
CapabilityGapReport { target: string; gaps: CapabilityGap[] }
```
No logic — adapters populate these from Phase 5 onward.

## 10. Testing strategy (TDD, red→green→refactor)

- `*.test.ts` beside source; fixtures under `__fixtures__/`.
- **Valid path:** one multi-type fixture containing a relation *and* a component → constructs,
  normalizes, and validates clean (the exit-criteria happy path).
- **Malformed path:** one fixture per invariant (§6) plus key structural (Zod) failures, each
  asserting the expected `IrError.code` and `location`.
- **Determinism:** `normalize` idempotency test.
- ≥1 invariant test per invariant (exit criterion).

## 11. Out of scope (explicit)

- Expressions / Ring 1 (Phase 4), permissions (Phase 5), any target emission (Phase 2+).
- JSON Schema artifact (D2), capability-gap *logic* (Phase 5+), AI primitives (Phase 9).
- Target-specific naming/representability rules — surfaced later via the capability-gap report,
  never as IR invariants.

## 12. Exit criteria (from PLAN.md Phase 1)

- Construct a valid multi-type IR (with a relation and a component) in tests.
- Each malformed IR fixture fails with the expected error.
- ≥1 invariant test per invariant.
- `pnpm -r typecheck` / `pnpm -r test` / `pnpm lint` green; CI green.
