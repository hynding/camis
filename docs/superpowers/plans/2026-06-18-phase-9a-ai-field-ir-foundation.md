# Phase 9A (Plan 1 of 3) — AI Field IR Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the neutral `ai` field-annotation primitive to the IR — schema, placeholder extraction, validation invariants, and a capability feature — the shared contract the three adapter emitters (Plans 2–3) build on.

**Architecture:** An optional `ai: { model?, prompt, trigger }` block on `string`/`text`/`richText` fields (Zod, in `@camis/ir-schema`); a helper extracts `{{placeholders}}` from the prompt (the derived source set); `@camis/ir-core` invariants reject unknown placeholders and `ai`+`computed` conflicts. Storage/column emission is unchanged — only the IR gains the annotation.

**Tech Stack:** TypeScript, Zod v3, Vitest. No runtime/codegen here — this plan is pure IR + validation.

**Spec:** `docs/superpowers/specs/2026-06-18-phase-9a-ai-field-runtime-spec-design.md` (§3).

---

## Conventions

- Single test file: `pnpm --filter <pkg> exec vitest run src/<file>.test.ts`. Per package: `pnpm --filter <pkg> test` / `typecheck` / `lint`.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- No `any` in sources.

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/ir-schema/src/ai.ts` (create) | The `ai` Zod schema + `aiPlaceholders(prompt)` extractor. |
| `packages/ir-schema/src/fields.ts` (modify) | Accept `ai` on `string`/`text`/`richText` (not `email`) via the `textLike` factory. |
| `packages/ir-schema/src/errors.ts` (modify) | Add `unknown_ai_source` + `ai_computed_conflict` error codes. |
| `packages/ir-schema/src/capability.ts` (modify) | Add the `aiField` feature to `CapabilityDescriptor.features`. |
| `packages/ir-schema/src/index.ts` (modify) | Export `ai`, `Ai`, `aiPlaceholders`. |
| `packages/ir-core/src/invariants.ts` (modify) | Reject unknown `{{placeholders}}` + `ai`+`computed` conflict. |

---

## Task 1: The `ai` schema + placeholder extractor (`ir-schema/ai.ts`)

**Files:** Create `packages/ir-schema/src/ai.ts`, `packages/ir-schema/src/ai.test.ts`.

- [ ] **Step 1: Write the failing test** — `packages/ir-schema/src/ai.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ai, aiPlaceholders } from "./ai";

describe("ai schema", () => {
  it("accepts a minimal ai block (model optional)", () => {
    expect(ai.safeParse({ prompt: "Summarize: {{body}}", trigger: "onCreate" }).success).toBe(true);
  });
  it("accepts an explicit model + onCreateOrUpdate trigger", () => {
    expect(ai.safeParse({ model: "claude-haiku-4-5", prompt: "x {{a}}", trigger: "onCreateOrUpdate" }).success).toBe(true);
  });
  it("rejects an empty prompt and an unknown trigger", () => {
    expect(ai.safeParse({ prompt: "", trigger: "onCreate" }).success).toBe(false);
    expect(ai.safeParse({ prompt: "x", trigger: "never" }).success).toBe(false);
  });
});

describe("aiPlaceholders", () => {
  it("extracts unique field names from {{placeholders}}", () => {
    expect(aiPlaceholders("Title {{title}}, body {{body}}, again {{title}}")).toEqual(["title", "body"]);
  });
  it("tolerates whitespace and returns [] when none", () => {
    expect(aiPlaceholders("a {{ name }} b")).toEqual(["name"]);
    expect(aiPlaceholders("no placeholders")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/ir-schema exec vitest run src/ai.test.ts`.

- [ ] **Step 3: Implement** — `packages/ir-schema/src/ai.ts`:

```ts
import { z } from "zod";

export const AI_TRIGGERS = ["onCreate", "onUpdate", "onCreateOrUpdate"] as const;
export type AiTrigger = (typeof AI_TRIGGERS)[number];

export const ai = z.object({
  model: z.string().min(1).optional(), // optional, provider-opaque pass-through
  prompt: z.string().min(1), // template with {{field}} placeholders
  trigger: z.enum(AI_TRIGGERS),
});
export type Ai = z.infer<typeof ai>;

// Extract the unique {{placeholder}} field names from a prompt template (the derived source set).
export const aiPlaceholders = (prompt: string): string[] => {
  const re = /\{\{\s*([a-z][A-Za-z0-9]*)\s*\}\}/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) out.push(m[1]!);
  return [...new Set(out)];
};
```

(The placeholder pattern matches a `fieldName` shape — lowercase-initial alphanumerics — consistent with `identifiers.ts`.)

- [ ] **Step 4: Run green** — `pnpm --filter @camis/ir-schema exec vitest run src/ai.test.ts`; `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/ir-schema/src/ai.ts packages/ir-schema/src/ai.test.ts
git commit -m "feat(ir-schema): ai field-annotation schema + placeholder extractor

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Wire `ai` into the field schema + capability + errors + exports

**Files:** Modify `packages/ir-schema/src/fields.ts`, `errors.ts`, `capability.ts`, `index.ts`; test `packages/ir-schema/src/fields.test.ts`.

- [ ] **Step 1: Write the failing test** — add to `packages/ir-schema/src/fields.test.ts` (it already imports `field`; add only this `describe` block, no new imports):

```ts
describe("ai annotation on fields", () => {
  it("accepts ai on a text field", () => {
    const r = field.safeParse({ type: "text", name: "summary", ai: { prompt: "Sum {{body}}", trigger: "onCreate" } });
    expect(r.success).toBe(true);
  });
  it("accepts ai on string and richText", () => {
    expect(field.safeParse({ type: "string", name: "blurb", ai: { prompt: "{{title}}", trigger: "onUpdate" } }).success).toBe(true);
    expect(field.safeParse({ type: "richText", name: "draft", ai: { prompt: "{{title}}", trigger: "onCreateOrUpdate" } }).success).toBe(true);
  });
  it("strips ai on an email field (email is not an AI field)", () => {
    const r = field.safeParse({ type: "email", name: "contact", ai: { prompt: "{{x}}", trigger: "onCreate" } });
    expect(r.success).toBe(true);
    expect((r.success ? r.data : ({} as never)) as Record<string, unknown>).not.toHaveProperty("ai");
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/ir-schema exec vitest run src/fields.test.ts`.

- [ ] **Step 3: Implement:**
  1. In `packages/ir-schema/src/fields.ts`, add the import at the top: `import { ai } from "./ai";` and change the `textLike` factory to accept `ai` for non-email types:

```ts
const textLike = (type: "string" | "text" | "richText" | "email") =>
  z.object({
    type: z.literal(type),
    ...common,
    unique: z.boolean().optional(),
    ...len,
    default: z.string().optional(),
    ...(type === "email" ? {} : { ai: ai.optional() }),
  });
```

  (Zod objects are non-strict by default, so an `ai` key on the `email` variant is silently stripped — email is not an AI field. The other field variants never declare `ai`, so it is stripped there too.)

  2. In `packages/ir-schema/src/errors.ts`, add two members to the `IrErrorCode` union (place them alongside the existing field/rule codes):

```ts
  | "unknown_ai_source"
  | "ai_computed_conflict"
```

  3. In `packages/ir-schema/src/capability.ts`, add `aiField` to the `features` record key union:

```ts
  features: Partial<
    Record<"dynamicZone" | "component" | "softDelete" | "draftPublish" | "media" | "aiField", boolean>
  >;
```

  4. In `packages/ir-schema/src/index.ts`, add:

```ts
export { ai, aiPlaceholders, AI_TRIGGERS } from "./ai";
export type { Ai, AiTrigger } from "./ai";
```

- [ ] **Step 4: Run green + regression** — `pnpm --filter @camis/ir-schema exec vitest run src/fields.test.ts`; then `pnpm --filter @camis/ir-schema test` (all existing parse/field tests still pass — the change is additive); `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/ir-schema/src/fields.ts packages/ir-schema/src/errors.ts packages/ir-schema/src/capability.ts packages/ir-schema/src/index.ts packages/ir-schema/src/fields.test.ts
git commit -m "feat(ir-schema): accept ai on string/text/richText; add aiField capability + error codes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: AI validation invariants (`ir-core`)

**Files:** Modify `packages/ir-core/src/invariants.ts`, `packages/ir-core/src/invariants.test.ts`.

- [ ] **Step 1: Write the failing test** — add to `packages/ir-core/src/invariants.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { validateInvariants } from "./invariants";

const docWith = (articleFields: unknown[]): IrDocument =>
  ({ version: 1, contentTypes: [{ name: "Article", kind: "collection", fields: articleFields }], components: [] }) as IrDocument;

describe("ai invariants", () => {
  it("accepts an ai field whose placeholders name existing scalar fields", () => {
    const errors = validateInvariants(docWith([
      { type: "text", name: "body" },
      { type: "text", name: "summary", ai: { prompt: "Sum {{body}}", trigger: "onCreate" } },
    ]));
    expect(errors.filter((e) => e.code === "unknown_ai_source")).toHaveLength(0);
  });
  it("rejects an unknown placeholder", () => {
    const errors = validateInvariants(docWith([
      { type: "text", name: "summary", ai: { prompt: "Sum {{missing}}", trigger: "onCreate" } },
    ]));
    expect(errors.some((e) => e.code === "unknown_ai_source" && e.location.field === "summary")).toBe(true);
  });
  it("rejects a placeholder naming a relation/the field itself", () => {
    const errors = validateInvariants(docWith([
      { type: "relation", name: "author", relationKind: "manyToOne", target: "Article" },
      { type: "text", name: "summary", ai: { prompt: "{{author}} {{summary}}", trigger: "onCreate" } },
    ]));
    expect(errors.filter((e) => e.code === "unknown_ai_source")).toHaveLength(2);
  });
  it("rejects ai + computed on the same field", () => {
    const errors = validateInvariants(docWith([
      { type: "text", name: "summary", ai: { prompt: "x", trigger: "onCreate" }, computed: { kind: "lit", value: "y" } },
    ]));
    expect(errors.some((e) => e.code === "ai_computed_conflict" && e.location.field === "summary")).toBe(true);
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/ir-core exec vitest run src/invariants.test.ts`.

- [ ] **Step 3: Implement** — in `packages/ir-core/src/invariants.ts`:
  1. Add the import: `import { aiPlaceholders } from "@camis/ir-schema";` (extend the existing `@camis/ir-schema` import line or add a new one).
  2. Inside `checkFields`, in the `for (const f of fields)` loop, after the existing relation/component checks, add:

```ts
      const af = f as { ai?: { prompt: string }; computed?: unknown };
      if (af.ai) {
        if (af.computed !== undefined) {
          errors.push({
            code: "ai_computed_conflict",
            message: `field "${f.name}" cannot be both an AI field and computed`,
            location: { ...location, field: f.name },
            path: [],
          });
        }
        const scalarNames = new Set(
          fields
            .filter((g) => g.type !== "relation" && g.type !== "component" && g.type !== "dynamicZone")
            .map((g) => g.name),
        );
        for (const src of aiPlaceholders(af.ai.prompt)) {
          if (src === f.name || !scalarNames.has(src)) {
            errors.push({
              code: "unknown_ai_source",
              message: `AI field "${f.name}" references unknown source "${src}"`,
              location: { ...location, field: f.name },
              path: [],
            });
          }
        }
      }
```

  (`fields` and `location` are already in `checkFields` scope. The check runs for both content-type fields and component fields, which is fine — a component AI field's sources resolve within the component's own fields.)

- [ ] **Step 4: Run green + regression** — `pnpm --filter @camis/ir-core exec vitest run src/invariants.test.ts`; then `pnpm --filter @camis/ir-core test`; `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/ir-core/src/invariants.ts packages/ir-core/src/invariants.test.ts
git commit -m "feat(ir-core): validate ai field placeholders + reject ai/computed conflict

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Full sweep

- [ ] **Step 1:** `pnpm lint`; `pnpm -r typecheck`; `pnpm -r test` — all green (report counts). The change is additive: existing adapter goldens are unaffected (no adapter consumes `ai` yet — that is Plans 2–3). Confirm `git status` clean.

- [ ] **Step 2: Commit** (only if the sweep produced incidental fixes; otherwise skip):

```bash
git commit -am "chore: phase 9A IR foundation sweep

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** §3 `ai` block (`model?`/`prompt`/`trigger`) — Task 1. `ai` on string/text/richText not email — Task 2 (`textLike` gating). `aiField` capability — Task 2. Invariants: unknown placeholder, `ai`+`computed`, empty prompt (the last via `z.string().min(1)` in Task 1) — Tasks 1, 3. Placeholder extraction — Task 1. (Emission/runtime = Plans 2–3, out of scope here.)

**Placeholder scan:** No "TBD/TODO". Task 4 Step 2 is conditional ("only if the sweep produced incidental fixes") — that is an explicit conditional, not a vague placeholder. All code steps carry complete literals.

**Type consistency:** `ai`/`Ai`/`aiPlaceholders`/`AI_TRIGGERS` (Task 1) are imported by `fields.ts` + `index.ts` (Task 2) and `invariants.ts` (Task 3). The error codes `unknown_ai_source`/`ai_computed_conflict` (Task 2) are exactly the codes pushed in Task 3. The `aiField` capability key (Task 2) is the feature Plans 2–3 will set per adapter. The placeholder regex (lowercase-initial alphanumerics) matches the `fieldName` identifier shape the invariant validates against.
