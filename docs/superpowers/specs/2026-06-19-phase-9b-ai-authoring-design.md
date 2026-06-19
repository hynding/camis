# Phase 9B — Authoring-time AI: NL → validated IR mutations Design

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 9, sub-phase B (final). 9A (runtime AI field) is merged.
**Scope:** build `@camis/ai-authoring` — turn a natural-language instruction into **typed IR mutation
ops**, apply them to the current IR, and validate the result against the same `ir-core` guardrail as
everything else, with a validate-and-repair loop. Invalid proposals are repaired or rejected, never
returned as success and never written. The LLM lives behind a mocked interface; no network in unit tests.

---

## 1. Context & goal

ARCHITECTURE §6.1: authoring-time AI is **a producer of IR, not a special path around it** — "the AI
literally cannot emit an invalid model." 9B realizes this: NL → a list of **typed mutation ops** →
apply → `validate` (the guardrail) → repair on failure → return the validated IR. The exit criterion —
"an NL prompt produces a valid IR mutation that round-trips through validation; invalid proposals are
rejected/repaired, never written" — is met by construction: `author` only ever returns a document that
passed `@camis/ir-core` `validate`.

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Typed mutation ops**, not full-document replacement. | ARCHITECTURE's "NL → IR mutations"; auditable/reviewable; a bad op fails locally; avoids lossy full rewrites. |
| D2 | **Minimal core op set:** `addContentType`, `removeContentType`, `addField`, `removeField`, `renameField`. | Proves the NL→ops→apply→validate→repair loop end-to-end with the smallest applier; the schema is extensible later. YAGNI. |
| D3 | **The LLM is behind an injected `AiClient` interface**; the core never imports the SDK. The one real impl (`anthropic-client.ts`) reads the key from the environment and uses tool-use. | CLAUDE.md: AI/network behind interfaces, mocked, no network in unit tests, keys from env. |
| D4 | **`validate` (`@camis/ir-core`) is the IR-validity guardrail; the applier owns op applicability; both feed one repair loop.** | A mistargeted op (e.g. `addField` to an unknown type) must surface as a located error, not silently no-op into a falsely-passing doc. |
| D5 | **Validate-and-repair loop: 1 proposal + up to 2 repairs (configurable `maxRepairs`, default 2); fail-closed.** | Bounded LLM cost; precise located errors make repair effective; an invalid candidate is never returned as `ok`. |
| D6 | **`author` returns the validated IR + the ops; it never writes files.** | AI as a validated producer; the caller (CLI, Phase 10) persists only on `ok`. |
| D7 | **9B verifies well-formedness + op applicability, NOT semantic fulfillment of the NL** (inherently unverifiable). | An empty/no-op well-formed proposal returns `ok` with `ops: []`; the caller inspects the ops to judge intent. |

## 3. Architecture & data flow

`@camis/ai-authoring` exports:

```ts
author(request: AuthorRequest): Promise<AuthorResult>;

interface AuthorRequest {
  instruction: string;        // the NL instruction
  document: IrDocument;       // the current model (an empty doc for a fresh start)
  client: AiClient;           // the injected LLM seam
  maxRepairs?: number;        // default 2
}

type AuthorResult =
  | { ok: true; document: IrDocument; ops: Mutation[] }   // document already passed validate
  | { ok: false; errors: AuthoringError[] };              // exhausted the repair budget
```

`AuthoringError` is the `IrError` shape (`{ code; message; location; path }`) with a locally-defined
code union `IrErrorCode | "inapplicable_mutation"` — so `validate`'s `IrError`s slot in unchanged and
the applier's op-applicability errors coexist **without adding an authoring concept to `ir-schema`'s
`IrErrorCode`**.

Flow (in `author.ts`):
1. **Prompt** — `buildSystemPrompt()` (IR vocabulary + the mutation-op schema + "return ops only") and
   `buildUserPrompt(document, instruction)` (the current document via `stableJson` + the instruction).
2. **Propose** — `client.propose({ system, user })` → raw proposal (`unknown`).
3. **Parse** — the mutation Zod schema parses the raw proposal → `Mutation[]` (or Zod issues → repair).
4. **Apply** — `applyMutations(document, ops)` → `{ document: candidate; errors: IrError[] }` (errors
   for inapplicable ops).
5. **Validate** — `validate(candidate)` (Zod + normalize + invariants).
6. **Decide** — if the apply-errors are empty AND `validate` is `ok` ⇒ return `{ ok: true, document:
   validated, ops }`. Otherwise enter repair: append the combined errors + the rejected ops to the next
   user prompt and loop (step 2), up to `maxRepairs`. On exhaustion ⇒ `{ ok: false, errors }`.

**Files:** `mutation.ts` (op schema + types), `apply.ts` (applier), `prompts.ts` (prompt builders),
`client.ts` (the `AiClient` interface), `anthropic-client.ts` (real impl, thin, not unit-tested),
`author.ts` (the loop), `index.ts` (public exports).

## 4. Mutation ops + applier

`mutation.ts` (Zod), reusing `@camis/ir-schema`'s `field`, `contentType`, `fieldName`, `typeName` so a
proposed field is validated by the same definitions as everything else:

```ts
type Mutation =
  | { op: "addContentType"; contentType: ContentType }
  | { op: "removeContentType"; name: string }
  | { op: "addField"; contentType: string; field: Field }
  | { op: "removeField"; contentType: string; field: string }
  | { op: "renameField"; contentType: string; from: string; to: string };
// the proposal is `z.array(mutation)`
```

`applyMutations(doc: IrDocument, ops: Mutation[]): { document: IrDocument; errors: AuthoringError[] }` —
pure, total, never throws. It deep-clones `doc` and folds each op; it **reports an applicability error**
(`code: "inapplicable_mutation"`, with `location` naming the content type/field) when an op references a
missing target:
- `addContentType` of a duplicate name; `removeContentType` of an absent name.
- `addField`/`removeField`/`renameField` on an unknown content type; `removeField`/`renameField` of an
  absent field. (`renameField` to an existing field name applies and is caught as `duplicate_field` by
  `validate`.)

Apply-errors join `validate`'s errors in the repair loop (D4). This is why a mistargeted op cannot
silently no-op into a falsely-passing result.

## 5. The LLM seam (`AiClient`) + the real client

```ts
interface AiClient {
  propose(input: { system: string; user: string }): Promise<unknown>;
}
```

- The core (`author`/`prompts`/`apply`/`mutation`) depends only on this interface. Unit tests inject a
  **sequenced mock** that returns a scripted series of proposals across the repair loop (e.g. a bad op,
  then a good one). No network in unit tests.
- `anthropic-client.ts` is the single real implementation: it reads `ANTHROPIC_API_KEY` from the
  environment and calls the Anthropic Messages API with **tool-use** — a tool whose JSON-Schema input is
  the mutation-op array (derived from the Zod mutation schema); it returns the tool input as the raw
  proposal. It is thin and **not** unit-tested (network); one structural test with a mocked `fetch`
  asserts the request shape (model, tool schema, key sourced from env). The key is never embedded or
  logged.

## 6. Validate-and-repair loop

- **Budget:** 1 proposal + up to `maxRepairs` (default 2) repairs — at most 3 LLM calls.
- **Repair prompt:** the next `propose`'s user prompt appends the combined **structured errors**
  (apply-errors + `IrError`s from `validate`, each with code/message/location) AND the rejected ops, and
  asks the model to fix them. Located errors (which content type / field / rule) tell the model exactly
  what to correct.
- **Schema-invalid proposals** (ops that don't parse against the mutation Zod schema) are treated like a
  validation failure — the Zod issues are fed back as a repair.
- **Fail-closed:** if no candidate passes within the budget, `author` returns `{ ok: false, errors }`
  carrying the last failure's combined errors. An invalid candidate is never returned as `ok`.

## 7. Testing

- **`mutation.ts`** — parses each of the 5 ops; rejects malformed ops.
- **`apply.ts`** — each op folded over a fixture; totality (no throw); applicability errors for missing
  targets (e.g. `addField` to an unknown type → an `inapplicable_mutation` error).
- **`prompts.ts`** — snapshot the deterministic system/user/repair builders (document via `stableJson`).
- **`author.ts` (the spine), with a sequenced mock `AiClient`:** (a) valid first try → `ok`, the document
  reflects the op, `ops` returned; (b) invalid then repaired → bad op, then good op on repair → `ok`
  after one repair; (c) never valid → `ok: false` after the budget; (d) schema-invalid proposal → fed
  back as a repair. No network.
- **Exit-criteria test:** the NL example ("add a published boolean to Article") with a mock returning the
  `addField` op → a valid document that round-trips through `validate`; invalid variant is rejected.
- **`anthropic-client.ts`** — one structural test (mocked `fetch`) asserting the request shape; no live
  call.

## 8. Exit criteria (9B — closes Phase 9)

- An NL instruction produces a typed mutation that applies and **round-trips through `validate`**;
  `author` returns the validated `IrDocument` + the ops.
- An invalid proposal is **repaired** within the budget or **rejected** (`ok: false`) — never returned as
  `ok`, never written.
- The LLM is fully behind `AiClient`; unit tests use a mock with **no network**; the real client sources
  the key from the environment.
- `pnpm lint` / `pnpm -r typecheck` / `pnpm -r test` green.

## 9. Cross-cutting

- The IR is the single source of truth; `author` is a **producer** that returns validated IR and never
  writes. `validate` (`ir-core`) is the authoritative IR guardrail; the applier owns op applicability.
- All Anthropic SDK/key specifics are confined to `anthropic-client.ts`; the key is environment-supplied,
  never embedded or logged. No network in unit tests.
- No new Ring-1/Ring-2 surface — this is a build-time authoring tool, not generated runtime code.
- Determinism: prompt builders embed the document via `stableJson`; the applier is pure/total — so the
  prompt snapshots and the mock-driven loop tests are deterministic.
