# Phase 9A — Runtime AI: the "AI field" IR primitive + tri-target emission Design

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 9, sub-phase A (of A/B). 9B = `ai-authoring` (NL → validated IR), a later cycle.
**Scope:** add a neutral **AI field** primitive to the IR — a text-storable field whose value is
LLM-generated at runtime — and teach **all three adapters** (Strapi, Express, Filament) to emit the
generation wiring over a protected provider seam. Deterministic and offline-testable; no network in
unit tests or the gated boot. The "AI action" primitive is out of scope (a later sub-phase).

---

## 1. Context & goal

camis = "CMS with integrated AI"; runtime AI being a **first-class IR concept** rather than a bolt-on
is the differentiator (ARCHITECTURE §6.2). 9A delivers the first runtime-AI primitive: an **AI field**.
Its value-generation is async, side-effectful, network-bound — i.e. **Ring 2** — so the IR carries only
**declarative Ring-0 config** (`ai: { model?, prompt, trigger }`) that *generates* Ring-2 wiring plus a
protected provider seam. This mirrors the Phase-7 Ring-2 hook pattern (contract + lifecycle + protected
stub), specialized for generation. Emitting it in all three targets — two TypeScript, one PHP — proves
the primitive is genuinely neutral across languages.

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **AI field only** (no "AI action") in 9A. | Exactly meets Phase 9's exit criteria; smallest coherent slice; the action's invocation/endpoint model is a separate design. |
| D2 | **All three targets** (Strapi, Express, Filament) emit the wiring. | Strongest neutrality proof — one neutral `ai` block drives both TS and PHP provider seams + wiring. |
| D3 | **`ai` is an annotation on a normal text-storable field** (`string`/`text`/`richText`), not a new field type. | Storage/column emission is unchanged everywhere; the AI-ness adds only generation wiring. Minimal disruption; reuses every field/column emitter. |
| D4 | **`model` is optional + provider-opaque.** Omitted → the provider's default. | Keeps the IR vendor-neutral — it never has to name a vendor model; the provider seam owns model mapping. |
| D5 | **No explicit `sources`** — they are derived from the `{{placeholders}}` in `prompt`. | One source of truth; the derived set also drives change-detection. Avoids a drift invariant. |
| D6 | **`json`/structured output is deferred.** 9A outputs are text (`string`/`text`/`richText`). | Structured LLM output + parse/validate is a separate design. YAGNI. |
| D7 | **Change-detection without a fetch:** Express/Strapi regenerate iff a source key is present in the write payload; Filament iff `$model->isDirty(col)`. | Idiomatic per target; no extra query; avoids the awkward "load existing record" path in a Strapi `beforeUpdate`. |
| D8 | **Best-effort generation:** a provider failure is logged, non-fatal; the write succeeds with the field left unset (no auto-retry in 9A). | Never block content creation on a flaky LLM. Retry/queue is out of scope. |
| D9 | **Provider seam is protected (write-once) + deterministic-offline by default.** | Tests + the gated boot never hit the network; keys come from the environment, never embedded/logged. |

## 3. The AI-field primitive (`ir-schema` + `ir-core`)

The `ai` block, valid only on `string`/`text`/`richText` fields:

```ts
ai: {
  model?: string;                                       // optional, provider-opaque pass-through
  prompt: string;                                       // template with {{sourceField}} placeholders
  trigger: "onCreate" | "onUpdate" | "onCreateOrUpdate";
}
```

- **Schema (`ir-schema/fields.ts`):** add an optional `ai` object to the `string`/`text`/`richText`
  builders (NOT to numeric/boolean/relation/component/json). A small helper extracts
  `{{placeholders}}` from `prompt` (the derived source set).
- **Invariants (`ir-core`):** (a) every `{{placeholder}}` names an existing **non-relation, non-component**
  field of the same content type (and not the AI field itself); (b) a field may not have both `ai` and `computed`
  (mutually exclusive value origins); (c) `prompt` is non-empty. Violations are `IrError`s — the same
  validation guardrail everything else passes through.
- **Capability descriptor:** add an `aiField` feature; all three adapters declare support after 9A. A
  future non-supporting target emits a `downgrade` gap and stores a plain text column.

## 4. Emission pattern (per target)

Wiring is **opt-in per content type** — only content types with ≥1 AI field gain it; all other output
stays byte-identical. Each target:
1. **Protected provider seam** (seed): `generate(model?, prompt) → text`, deterministic-offline default
   (returns a marker, e.g. `` `[ai:${model ?? "default"}] ${prompt.slice(0, 80)}` ``) with a commented
   real-Anthropic-SDK seam reading the key from the environment.
2. **Generated wiring** (overwrite): on the field's trigger, assemble the prompt by substituting each
   `{{source}}` with the record's source value (the prompt template is an **escaped per-language
   literal**), call the provider, and write the result before persisting. For update triggers, only when
   a source changed (D7). Provider errors are best-effort (D8).
3. **Write/exposure exclusion:** the AI field is removed from client-writable inputs (Express route
   pick-list) and rendered read-only in the admin (Plan-8C-2 field mapping).

- **Express (TS):** generated `src/ai/populate.ts` (async) called from the create/update route handlers
  before insert/update; protected `src/ai/provider.ts` (seed). AI-bearing routes become `async`.
- **Strapi (TS):** a `beforeCreate`/`beforeUpdate` lifecycle mutating `event.params.data`; protected
  provider module in the generated Strapi project.
- **Filament (PHP):** an Eloquent model observer (`creating`/`updating`) setting the attribute via
  `isDirty` change-detection; protected `App\Ai\Provider` class + a PHP escaping helper for the prompt
  literal.

## 5. Verification

- **`ir-schema`/`ir-core` (unit + conformance):** the `ai` block parses on text fields and is rejected
  elsewhere; invariants reject unknown `{{placeholders}}`, `ai`+`computed`, and empty prompts; placeholder
  extraction is covered.
- **Each adapter (golden, deterministic):** the emitted provider seam (seed) + populate/lifecycle/
  observer wiring + pick-list/admin exclusion are byte-locked; a fixture **without** AI fields stays
  byte-identical to the current goldens; regeneration is idempotent.
- **Gated boot:** with the deterministic stub provider (no network, no `ANTHROPIC_API_KEY`): create a
  record → assert the AI field is populated by the stub; update a non-source field → assert it does NOT
  regenerate; update a source field → assert it DOES. Exercised on the existing per-target matrices.

## 6. Exit criteria (9A)

- A content type with an AI field (`ai` annotation) generates **working, golden-locked** generation
  wiring in **all three** targets (Strapi, Express, Filament).
- The gated boot proves the field is populated by the offline stub and honors the trigger +
  change-detection; no network / API key is required.
- Invalid `ai` configs (bad placeholder, `ai`+`computed`, empty prompt, wrong field type) are rejected
  by validation.
- Non-AI output stays byte-identical; `pnpm lint` / `pnpm -r typecheck` / `pnpm -r test` green.

## 7. Cross-cutting

- The IR is the single source of truth; the `ai` block is neutral and lives in `ir-schema`; each
  adapter's provider/SDK specifics are confined to that adapter.
- Runtime AI is **Ring 2** — declarative `ai` config generates Ring-2 wiring + a protected seam; the
  Ring-1 grammar is untouched. No Ring-1 additions.
- One-way authoritative generation; the author-controlled `prompt` is escaped as a per-language literal
  (the codegen-injection guard from 8B/Filament/Strapi).
- Generated wiring overwrites; the provider stub is protected (seed). API keys come from the environment,
  never embedded or logged.
- Determinism: stable ordering, escaped literals, offline-default provider — goldens and idempotent
  regen hold.
