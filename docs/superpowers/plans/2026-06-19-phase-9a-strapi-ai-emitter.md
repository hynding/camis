# Phase 9A (Plan 3 of 4) — Strapi AI-Field Emitter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@camis/adapter-strapi` emit AI-field generation as a `beforeCreate`/`beforeUpdate` lifecycle over a protected provider seam, driven by the `ai` IR annotation.

**Architecture:** A new `ai.ts` emitter produces `src/ai/provider.ts` (protected seed; deterministic offline default) and, per AI-bearing content type, a `lifecycles.ts` that assembles the prompt from the record's source attributes (Strapi attribute keys are the IR field names — no snake conversion), honors the trigger + change-detection, and calls the provider best-effort. A content type that already has a Phase-7 hook (which owns the same `lifecycles.ts`) gets a capability gap instead of a colliding file. Non-AI output stays byte-identical.

**Tech Stack:** TypeScript, Strapi v5 lifecycles, Vitest. `@camis/ir-schema` `aiPlaceholders`; `@camis/adapter-kernel` `stableJson`/`withMarker`.

**Spec:** `docs/superpowers/specs/2026-06-18-phase-9a-ai-field-runtime-spec-design.md` (§4 Strapi, §5).

---

## Conventions

- Package root: `packages/adapter-strapi/`.
- **Golden guard:** the AI wiring is opt-in per content type; every existing Strapi golden is AI-free and MUST stay byte-identical except where a task adds new AI goldens. After each task, `git status --short src/__golden__/` shows only intended changes. NEVER use vitest `-u` except where a task says to generate a named new golden.
- Emitted strings are data (`any` allowed inside them); our `.ts` sources are `any`-free + lint-clean.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/ai.ts` (create) | `aiFieldContentTypes(doc)`, `hasAiField(doc)`, the provider seam, `aiProviderFile()`, `aiLifecycleFile(ct)`. |
| `src/generate.ts` (modify) | Emit the provider + per-content-type AI lifecycle; gap a hook+AI collision. |
| `src/__fixtures__/ai.ts` (create) | An Article{body, summary:ai onCreateOrUpdate}. |
| `src/ai-golden.test.ts` (create) | Golden the AI lifecycle + provider + file-listing. |

---

## Task 1: The Strapi AI emitter (`ai.ts`)

**Files:** Create `src/ai.ts`, `src/ai.test.ts`.

- [ ] **Step 1: Write the failing test** — `src/ai.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ContentType, IrDocument } from "@camis/ir-schema";
import { aiFieldContentTypes, aiLifecycleFile, aiProviderFile, hasAiField } from "./ai";

const ct: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "text", name: "body" },
    { type: "text", name: "summary", ai: { prompt: "Sum {{body}}", trigger: "onCreateOrUpdate" } },
  ],
} as ContentType;
const doc: IrDocument = { version: 1, contentTypes: [ct], components: [] } as IrDocument;

describe("strapi ai emitter", () => {
  it("detects AI content types", () => {
    expect(hasAiField(doc)).toBe(true);
    expect(aiFieldContentTypes(doc).map((c) => c.name)).toEqual(["Article"]);
  });
  it("emits a protected provider seed", () => {
    const f = aiProviderFile();
    expect(f.path).toBe("src/ai/provider.ts");
    expect(f.mode).toBe("seed");
    expect(f.content).toContain("export async function generate");
    expect(f.content).toContain("ANTHROPIC_API_KEY");
  });
  it("emits a lifecycle that populates from event.params.data using field-name keys", () => {
    const f = aiLifecycleFile(ct);
    expect(f.path).toBe("src/api/article/content-types/article/lifecycles.ts");
    expect(f.content).toContain('import { generate } from "../../../../ai/provider";');
    expect(f.content).toContain("async beforeCreate(");
    expect(f.content).toContain("async beforeUpdate(");
    expect(f.content).toContain('"column": "summary"');
    expect(f.content).toContain('"sources": [');
    expect(f.content).toContain('"body"'); // source attribute name (no snake conversion)
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-strapi exec vitest run src/ai.test.ts`.

- [ ] **Step 3: Implement** — `src/ai.ts`:

```ts
import { stableJson, withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import { aiPlaceholders, type ContentType, type Field, type IrDocument } from "@camis/ir-schema";
import { strapiNames } from "./names";

type AiField = Field & { ai?: { model?: string; prompt: string; trigger: string } };
const aiOf = (f: Field): AiField["ai"] | undefined => (f as AiField).ai;

export const aiFieldContentTypes = (doc: IrDocument): ContentType[] =>
  doc.contentTypes.filter((ct) => ct.fields.some((f) => aiOf(f) !== undefined));

export const hasAiField = (doc: IrDocument): boolean => aiFieldContentTypes(doc).length > 0;

// Protected provider seam: deterministic + offline by default so dev/CI need no network or API key.
const PROVIDER = `// camis AI provider — REPLACE FOR PRODUCTION.
// Real impl: read process.env.ANTHROPIC_API_KEY and call the model SDK here.
export async function generate(model: string | undefined, prompt: string): Promise<string> {
  return \`[ai:\${model ?? "default"}] \${prompt.slice(0, 80)}\`;
}
`;

interface AiSpec {
  column: string;
  model?: string;
  prompt: string;
  trigger: string;
  sources: string[];
}

const specsFor = (ct: ContentType): AiSpec[] => {
  const specs: AiSpec[] = [];
  for (const f of ct.fields) {
    const a = aiOf(f);
    if (!a) continue;
    specs.push({
      column: f.name, // Strapi attribute key = IR field name (camelCase)
      ...(a.model !== undefined ? { model: a.model } : {}),
      prompt: a.prompt,
      trigger: a.trigger,
      sources: aiPlaceholders(a.prompt),
    });
  }
  return specs;
};

export const aiProviderFile = (): GeneratedFile => ({
  path: "src/ai/provider.ts",
  content: PROVIDER,
  mode: "seed",
});

export const aiLifecycleFile = (ct: ContentType): GeneratedFile => {
  const n = strapiNames(ct);
  const body = withMarker(`import { generate } from "../../../../ai/provider";

interface AiSpec {
  column: string;
  model?: string;
  prompt: string;
  trigger: string;
  sources: string[];
}

const SPECS: AiSpec[] = ${stableJson(specsFor(ct))};

async function populate(data: Record<string, unknown>, mode: "create" | "update"): Promise<void> {
  for (const f of SPECS) {
    const fires =
      f.trigger === "onCreate"
        ? mode === "create"
        : f.trigger === "onUpdate"
          ? mode === "update"
          : true;
    if (!fires) continue;
    if (mode === "update" && !f.sources.some((s) => s in data)) continue;
    let prompt = f.prompt;
    for (const s of f.sources) prompt = prompt.split(\`{{\${s}}}\`).join(String(data[s] ?? ""));
    try {
      data[f.column] = await generate(f.model, prompt);
    } catch (err) {
      console.error(\`AI generation failed for \${f.column}:\`, err);
    }
  }
}

export default {
  async beforeCreate(event: { params: { data: Record<string, unknown> } }) {
    await populate(event.params.data, "create");
  },
  async beforeUpdate(event: { params: { data: Record<string, unknown> } }) {
    await populate(event.params.data, "update");
  },
};
`);
  return {
    path: `src/api/${n.singularName}/content-types/${n.singularName}/lifecycles.ts`,
    content: body,
  };
};
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-strapi exec vitest run src/ai.test.ts`; `… typecheck`; `… lint`; `git status --short src/__golden__/` empty.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi/src/ai.ts packages/adapter-strapi/src/ai.test.ts
git commit -m "feat(adapter-strapi): emit AI provider seam + lifecycle from ai annotations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Wire AI emission into `generate.ts`

**Files:** Modify `src/generate.ts`, `src/generate.test.ts`.

The provider is emitted once when any content type has an AI field; a `lifecycles.ts` is emitted per
AI-bearing content type — UNLESS that content type already owns a Phase-7 hook lifecycle (same path), in
which case emit an `aiHookCollision` capability gap and skip the AI lifecycle.

- [ ] **Step 1: Write the failing test** — add to `src/generate.test.ts` (use the adapter's existing `strapiAdapter`/generate entry point and `IrBundle` shape already used by other tests in this file):

```ts
it("emits the AI provider + lifecycle for an AI-bearing content type", () => {
  const r = strapiAdapter.generate({ document: { version: 1, contentTypes: [
    { name: "Article", kind: "collection", fields: [
      { type: "text", name: "body" },
      { type: "text", name: "summary", ai: { prompt: "Sum {{body}}", trigger: "onCreate" } },
    ] },
  ], components: [] }, roles: [] } as never);
  const paths = r.files.map((f) => f.path);
  expect(paths).toContain("src/ai/provider.ts");
  expect(paths).toContain("src/api/article/content-types/article/lifecycles.ts");
  expect(r.files.find((f) => f.path === "src/api/article/content-types/article/lifecycles.ts")!.content).toContain("generate");
});
it("emits no AI files when no content type has an ai field", () => {
  const r = strapiAdapter.generate({ document: { version: 1, contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "text", name: "body" }] }], components: [] }, roles: [] } as never);
  expect(r.files.some((f) => f.path === "src/ai/provider.ts")).toBe(false);
});
it("gaps a content type that has BOTH a hook and an ai field (lifecycle collision)", () => {
  const r = strapiAdapter.generate({ document: { version: 1, hooks: [
    { name: "Enrich", trigger: "onPublish", contentType: "Article", input: [{ name: "body", type: "text" }], output: [{ name: "summary", type: "text" }] },
  ], contentTypes: [
    { name: "Article", kind: "collection", fields: [
      { type: "text", name: "body" },
      { type: "text", name: "summary", ai: { prompt: "Sum {{body}}", trigger: "onCreate" } },
    ] },
  ], components: [] }, roles: [] } as never);
  expect(r.gaps.gaps.some((g) => g.feature === "aiHookCollision" && g.location.contentType === "Article")).toBe(true);
  // exactly one lifecycles.ts for Article (the hook's), not two
  expect(r.files.filter((f) => f.path === "src/api/article/content-types/article/lifecycles.ts")).toHaveLength(1);
});
```

(If `strapiAdapter`/the generate entry name differs in this file, use whatever the existing tests import. The third test's `hooks` array uses the `@camis/ir-schema` `Hook` shape: `{ name, trigger: "onPublish", contentType, input, output }`.)

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-strapi exec vitest run src/generate.test.ts`.

- [ ] **Step 3: Implement** — in `src/generate.ts`:
  1. Add the import:

```ts
import { aiFieldContentTypes, aiLifecycleFile, aiProviderFile, hasAiField } from "./ai";
```

  2. Inside `generate`, after the normalized `doc` and the existing hook/content-type emission, and where the `gaps` array is in scope, add (adapt variable names to the file — `doc`, `files`, `gaps` already exist):

```ts
    if (hasAiField(doc)) {
      files.push(aiProviderFile());
      const hookCts = new Set((doc.hooks ?? []).map((h) => h.contentType));
      for (const ct of aiFieldContentTypes(doc)) {
        if (hookCts.has(ct.name)) {
          gaps.push({
            feature: "aiHookCollision",
            location: { contentType: ct.name },
            severity: "downgrade",
            message: `"${ct.name}" has both a hook and an AI field; both target lifecycles.ts. The hook lifecycle wins; AI generation is not wired for this type.`,
          });
          continue;
        }
        files.push(aiLifecycleFile(ct));
      }
    }
```

  (Place this so the `aiProviderFile()` and lifecycle pushes happen alongside the other `files.push(...)` calls, and the gap push uses the same `gaps` array returned in the result. If `gaps` is assembled separately, push to that array.)

- [ ] **Step 4: Run green + REGRESSION** — `pnpm --filter @camis/adapter-strapi exec vitest run src/generate.test.ts`; then `pnpm --filter @camis/adapter-strapi test` (all existing goldens AI-free → unchanged); `git status --short src/__golden__/` empty; `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi/src/generate.ts packages/adapter-strapi/src/generate.test.ts
git commit -m "feat(adapter-strapi): emit AI provider + lifecycle; gap hook/AI lifecycle collision

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: AI fixture + goldens

**Files:** Create `src/__fixtures__/ai.ts`, `src/ai-golden.test.ts`, golden dir `src/__golden__/ai/`.

- [ ] **Step 1: Fixture** — `src/__fixtures__/ai.ts`:

```ts
import type { IrBundle } from "@camis/permissions";

export const aiFixture: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "text", name: "body" },
          { type: "text", name: "summary", ai: { prompt: "Summarize in one line: {{body}}", trigger: "onCreateOrUpdate" } },
        ],
      },
    ],
    components: [],
  },
  roles: [],
};
```

(If the Strapi adapter's `generate` takes the bundle's `document` directly rather than the bundle, mirror the existing fixtures in `src/__fixtures__/`. Match their shape.)

- [ ] **Step 2: Golden test** — `src/ai-golden.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { strapiAdapter } from "./generate";
import { aiFixture } from "./__fixtures__/ai";

describe("strapi ai golden", () => {
  const result = strapiAdapter.generate(aiFixture as never);
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("lifecycle golden", async () => {
    await expect(c("src/api/article/content-types/article/lifecycles.ts")).toMatchFileSnapshot("./__golden__/ai/lifecycles.ts.txt");
  });
  it("provider golden (seed)", async () => {
    await expect(c("src/ai/provider.ts")).toMatchFileSnapshot("./__golden__/ai/provider.ts.txt");
  });
  it("file-listing includes the AI files", () => {
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("src/ai/provider.ts");
    expect(paths).toContain("src/api/article/content-types/article/lifecycles.ts");
  });
  it("is idempotent", () => {
    expect(strapiAdapter.generate(aiFixture as never)).toEqual(result);
  });
});
```

(Match `strapiAdapter.generate(...)`'s exact call signature to the existing golden tests in this package — some take the bundle, some the document. Use the same form they use.)

- [ ] **Step 3: Generate + INSPECT** — `pnpm --filter @camis/adapter-strapi exec vitest run src/ai-golden.test.ts -u`. READ and confirm:
  - `lifecycles.ts.txt`: `import { generate } from "../../../../ai/provider";`; `SPECS` with `"column": "summary"`, `"trigger": "onCreateOrUpdate"`, `"sources": ["body"]`; `beforeCreate`/`beforeUpdate` calling `populate(...)`; the `@camis:generated` marker.
  - `provider.ts.txt`: `export async function generate(model: string | undefined, prompt: string)`, offline default, `ANTHROPIC_API_KEY` comment, NO marker (seed).
  - If wrong, STOP and report.

- [ ] **Step 4: Regression** — `pnpm --filter @camis/adapter-strapi test` (ALL green); `git status --short src/__golden__/` shows ONLY new files under `ai/`; all existing Strapi goldens unchanged. `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-strapi/src/__fixtures__/ai.ts packages/adapter-strapi/src/ai-golden.test.ts packages/adapter-strapi/src/__golden__/ai
git commit -m "test(adapter-strapi): AI fixture + lifecycle/provider goldens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Full sweep

- [ ] **Step 1:** `pnpm lint`; `pnpm -r typecheck`; `pnpm -r test` — all green (report counts). Confirm the only new goldens are `src/__golden__/ai/*` and all other adapters' goldens are unchanged. `git status` clean.

  (The Strapi structural smoke test (`smoke.structural.test.ts`) parses emitted TS; if it has a mechanism to include new fixtures, the AI lifecycle is plain TS and parses. Do NOT add a live Strapi boot in this plan — the Express gated boot is the behavioral oracle for populate + change-detection; the Strapi golden proves emission.)

- [ ] **Step 2: Commit** (only if the sweep produced incidental fixes; otherwise skip).

---

## Self-review (completed by plan author)

**Spec coverage:** §4 Strapi — provider seam (seed, offline default, key-from-env comment) + `beforeCreate`/`beforeUpdate` lifecycle mutating `event.params.data` (Task 1); change-detection via "source attribute present in the payload" (Task 1 `populate`); prompt assembly from sources (Task 1); Strapi attribute keys = IR field names, so no snake conversion (Task 1 `specsFor` uses `f.name`). Opt-in per content type, non-AI byte-identical (Tasks 2, regression). The hook/AI lifecycle collision is a documented gap (Task 2). §5 golden coverage (Task 3). (Behavioral populate is proven by the Express gated boot already merged; Filament is Plan 4.)

**Placeholder scan:** No "TBD/TODO". Notes about matching the existing `strapiAdapter.generate(...)` call shape are concrete instructions to follow the package's established pattern, not placeholders. All emitter code is complete literals.

**Type consistency:** `aiFieldContentTypes`/`hasAiField`/`aiProviderFile`/`aiLifecycleFile` (Task 1) consumed by `generate.ts` (Task 2). The `AiSpec` shape (`column`/`model?`/`prompt`/`trigger`/`sources:string[]`, Task 1) is the same in the emitted lifecycle's interface + `populate` consumer. The fixture's `onCreateOrUpdate` + `{{body}}` (Task 3) drive the golden's SPECS. The collision gap `feature: "aiHookCollision"` (Task 2) matches its test assertion.
