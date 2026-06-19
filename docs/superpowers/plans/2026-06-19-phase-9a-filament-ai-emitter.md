# Phase 9A (Plan 4 of 4) — Filament (PHP) AI-Field Emitter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@camis/adapter-filament` emit AI-field generation as an Eloquent model observer over a protected PHP provider seam, closing Phase 9A (AI field in all three targets — TS + PHP).

**Architecture:** A new `ai.ts` emitter produces `app/Ai/Provider.php` (protected seed; deterministic offline default) and, per AI-bearing content type, an `app/Observers/<Model>Observer.php` whose `creating`/`updating` methods assemble the prompt from the record's snake-case source columns (`{{field}}` → `$record-><snake_col>`), honor the trigger + `isDirty` change-detection, and call `Provider::generate`. The AI content type's model is emitted `observed`. A content type that already has a Phase-7 hook owns the same `<Model>Observer.php`, so it gets a capability gap instead of a colliding file. The author-controlled prompt is a PHP-escaped single-quoted literal.

**Tech Stack:** TypeScript emitting PHP (Laravel/Eloquent), Vitest golden tests. `@camis/ir-schema` `aiPlaceholders`.

**Spec:** `docs/superpowers/specs/2026-06-18-phase-9a-ai-field-runtime-spec-design.md` (§4 Filament, §5).

---

## Conventions

- Package root: `packages/adapter-filament/`.
- **Golden guard:** the AI wiring is opt-in per content type; every existing Filament golden is AI-free and MUST stay byte-identical except where a task adds new AI goldens. After each task, `git status --short src/__golden__/` shows only intended changes. NEVER use vitest `-u` except where a task says to generate a named new golden.
- Emitted strings are data (`any` allowed inside them); our `.ts` sources are `any`-free + lint-clean.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/ai.ts` (create) | `aiFieldContentTypes(doc)`, `hasAiField(doc)`, the PHP provider seam, `aiProviderFile()`, `emitAiObserver(ct)`. |
| `src/generate.ts` (modify) | Mark AI content types `observed`; emit the provider + observers; gap a hook+AI collision. |
| `src/__fixtures__/ai.ts` (create) | An Article{body, summary:ai onCreateOrUpdate} IrBundle. |
| `src/ai-golden.test.ts` (create) | Golden the AI observer + provider; assert the model is observed. |

---

## Task 1: The Filament AI emitter (`ai.ts`)

**Files:** Create `src/ai.ts`, `src/ai.test.ts`.

- [ ] **Step 1: Write the failing test** — `src/ai.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ContentType, IrDocument } from "@camis/ir-schema";
import { aiFieldContentTypes, aiProviderFile, emitAiObserver, hasAiField } from "./ai";

const ct: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "text", name: "body" },
    { type: "text", name: "summary", ai: { prompt: "Summarize: {{body}}", trigger: "onCreateOrUpdate" } },
  ],
} as ContentType;
const doc: IrDocument = { version: 1, contentTypes: [ct], components: [] } as IrDocument;

describe("filament ai emitter", () => {
  it("detects AI content types", () => {
    expect(hasAiField(doc)).toBe(true);
    expect(aiFieldContentTypes(doc).map((c) => c.name)).toEqual(["Article"]);
  });
  it("emits a protected PHP provider seed", () => {
    const f = aiProviderFile();
    expect(f.path).toBe("app/Ai/Provider.php");
    expect(f.mode).toBe("seed");
    expect(f.content).toContain("namespace App\\Ai;");
    expect(f.content).toContain("public static function generate(?string $model, string $prompt): string");
    expect(f.content).toContain("ANTHROPIC_API_KEY");
  });
  it("emits an observer that populates on creating/updating with isDirty + escaped prompt", () => {
    const php = emitAiObserver(ct);
    expect(php).toContain("class ArticleObserver");
    expect(php).toContain("public function creating(Article $record): void");
    expect(php).toContain("public function updating(Article $record): void");
    expect(php).toContain("$isCreate || ($record->isDirty('body'))"); // onCreateOrUpdate + change-detection
    expect(php).toContain("str_replace(['{{body}}'], [(string) $record->body], 'Summarize: {{body}}')");
    expect(php).toContain("$record->summary = Provider::generate(null, $prompt);");
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-filament exec vitest run src/ai.test.ts`.

- [ ] **Step 3: Implement** — `src/ai.ts`:

```ts
import type { GeneratedFile } from "@camis/adapter-kernel";
import { aiPlaceholders, type ContentType, type Field, type IrDocument } from "@camis/ir-schema";
import { PHP_MARKER } from "./hooks/names";
import { filamentNames, snakeColumn } from "./names";

type AiField = Field & { ai?: { model?: string; prompt: string; trigger: string } };
const aiOf = (f: Field): AiField["ai"] | undefined => (f as AiField).ai;

export const aiFieldContentTypes = (doc: IrDocument): ContentType[] =>
  doc.contentTypes.filter((ct) => ct.fields.some((f) => aiOf(f) !== undefined));

export const hasAiField = (doc: IrDocument): boolean => aiFieldContentTypes(doc).length > 0;

// Wrap an author-controlled string as a single-quoted PHP literal (escape \ and ').
const phpSingleQuoted = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// Protected PHP provider seam: deterministic + offline by default (no network / API key in dev/CI).
const PROVIDER = `<?php

declare(strict_types=1);

namespace App\\Ai;

final class Provider
{
    // camis AI provider — REPLACE FOR PRODUCTION.
    // Real impl: read env('ANTHROPIC_API_KEY') and call the model SDK here.
    public static function generate(?string $model, string $prompt): string
    {
        return '[ai:' . ($model ?? 'default') . '] ' . substr($prompt, 0, 80);
    }
}
`;

export const aiProviderFile = (): GeneratedFile => ({
  path: "app/Ai/Provider.php",
  content: PROVIDER,
  mode: "seed",
});

const fireCondition = (trigger: string, dirtyExpr: string): string => {
  if (trigger === "onCreate") return "$isCreate";
  if (trigger === "onUpdate") return `!$isCreate && (${dirtyExpr})`;
  return `$isCreate || (${dirtyExpr})`;
};

export const emitAiObserver = (ct: ContentType): string => {
  const n = filamentNames(ct);
  const blocks: string[] = [];
  for (const f of ct.fields) {
    const a = aiOf(f);
    if (!a) continue;
    const col = snakeColumn(f.name);
    const phs = aiPlaceholders(a.prompt); // IR field names (camelCase)
    const searches = phs.map((ph) => phpSingleQuoted(`{{${ph}}}`)).join(", ");
    const replaces = phs.map((ph) => `(string) $record->${snakeColumn(ph)}`).join(", ");
    const dirty =
      phs.length > 0 ? phs.map((ph) => `$record->isDirty('${snakeColumn(ph)}')`).join(" || ") : "false";
    const model = a.model !== undefined ? phpSingleQuoted(a.model) : "null";
    blocks.push(`        if (${fireCondition(a.trigger, dirty)}) {
            $prompt = str_replace([${searches}], [${replaces}], ${phpSingleQuoted(a.prompt)});
            $record->${col} = Provider::generate(${model}, $prompt);
        }`);
  }
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Observers;

use App\\Ai\\Provider;
use App\\Models\\${n.model};

class ${n.model}Observer
{
    public function creating(${n.model} $record): void
    {
        $this->populateAi($record, true);
    }

    public function updating(${n.model} $record): void
    {
        $this->populateAi($record, false);
    }

    private function populateAi(${n.model} $record, bool $isCreate): void
    {
${blocks.join("\n")}
    }
}
`;
};
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-filament exec vitest run src/ai.test.ts`; `… typecheck`; `… lint`; `git status --short src/__golden__/` empty.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-filament/src/ai.ts packages/adapter-filament/src/ai.test.ts
git commit -m "feat(adapter-filament): emit PHP AI provider seam + Eloquent observer from ai annotations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Wire AI emission into `generate.ts`

**Files:** Modify `src/generate.ts`, `src/generate.test.ts`.

AI content types are marked `observed` (so `emitModel` adds the `ObservedBy` attribute) and get an
observer + the shared provider. A content type that already has a Phase-7 hook (in
`hooks.observedModels`) owns the same `<Model>Observer.php`, so it gets an `aiHookCollision` gap and is
NOT AI-wired.

- [ ] **Step 1: Write the failing test** — add to `src/generate.test.ts` (this file already imports `filamentAdapter`; Filament's `generate(ir)` takes a single `IrBundle` arg):

```ts
it("emits the AI provider + observer and marks the model observed for an AI content type", () => {
  const r = filamentAdapter.generate({ document: { version: 1, contentTypes: [
    { name: "Article", kind: "collection", fields: [
      { type: "text", name: "body" },
      { type: "text", name: "summary", ai: { prompt: "Sum {{body}}", trigger: "onCreate" } },
    ] },
  ], components: [] }, roles: [] } as never);
  const paths = r.files.map((f) => f.path);
  expect(paths).toContain("app/Ai/Provider.php");
  expect(paths).toContain("app/Observers/ArticleObserver.php");
  expect(r.files.find((f) => f.path === "app/Models/Article.php")!.content).toContain("ObservedBy");
});
it("emits no AI files when no content type has an ai field", () => {
  const r = filamentAdapter.generate({ document: { version: 1, contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "text", name: "body" }] }], components: [] }, roles: [] } as never);
  expect(r.files.some((f) => f.path === "app/Ai/Provider.php")).toBe(false);
});
it("gaps a content type with BOTH a hook and an ai field (observer collision)", () => {
  const r = filamentAdapter.generate({ document: { version: 1, hooks: [
    { name: "Enrich", trigger: "onPublish", contentType: "Article", input: [{ name: "body", type: "text" }], output: [{ name: "summary", type: "text" }] },
  ], contentTypes: [
    { name: "Article", kind: "collection", fields: [
      { type: "text", name: "body" },
      { type: "text", name: "summary", ai: { prompt: "Sum {{body}}", trigger: "onCreate" } },
    ] },
  ], components: [] }, roles: [] } as never);
  expect(r.gaps.gaps.some((g) => g.feature === "aiHookCollision" && g.location.contentType === "Article")).toBe(true);
  expect(r.files.filter((f) => f.path === "app/Observers/ArticleObserver.php")).toHaveLength(1);
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-filament exec vitest run src/generate.test.ts`.

- [ ] **Step 3: Implement** — in `src/generate.ts`. The current shape (verified): `const doc = normalize(ir.document); const rel = resolveRelations(doc); const hooks = emitHookFiles(doc); const files = []; const gaps = []; doc.contentTypes.forEach((ct, i) => { ...; files.push({ path: \`app/Models/${names.model}.php\`, content: emitModel(ct, rel.methods.get(ct.name) ?? [], hooks.observedModels.has(ct.name)) }); ... }); [...pivots...]; const perm = emitPermissions(doc, ir.roles); const allFiles = [...files, ...hooks.files, ...perm.files]; return { files: allFiles, manifest: buildManifest(allFiles), gaps: { target: "filament", gaps: [...gaps, ...perm.gaps] } };`

  1. Add the import:

```ts
import { aiFieldContentTypes, aiProviderFile, emitAiObserver, hasAiField } from "./ai";
```

  2. BEFORE the `doc.contentTypes.forEach(...)` loop, compute the AI plan (so the loop can read `aiObservedModels`):

```ts
    const aiObservedModels = new Set<string>();
    const aiGenFiles: GeneratedFile[] = [];
    const aiGaps: CapabilityGap[] = [];
    if (hasAiField(doc)) {
      aiGenFiles.push(aiProviderFile());
      for (const ct of aiFieldContentTypes(doc)) {
        if (hooks.observedModels.has(ct.name)) {
          aiGaps.push({
            feature: "aiHookCollision",
            location: { contentType: ct.name },
            severity: "downgrade",
            message: `"${ct.name}" has both a hook and an AI field; both target the model observer. The hook observer wins; AI generation is not wired for this type.`,
          });
          continue;
        }
        aiObservedModels.add(ct.name);
        aiGenFiles.push({
          path: `app/Observers/${filamentNames(ct).model}Observer.php`,
          content: emitAiObserver(ct),
        });
      }
    }
```

  3. In the `emitModel(...)` call inside the loop, OR-in the AI observed flag:

```ts
        content: emitModel(
          ct,
          rel.methods.get(ct.name) ?? [],
          hooks.observedModels.has(ct.name) || aiObservedModels.has(ct.name),
        ),
```

  4. Change the `allFiles` line to append `...aiGenFiles`, and the returned `gaps` to append `...aiGaps`:

```ts
    const allFiles = [...files, ...hooks.files, ...perm.files, ...aiGenFiles];
    return {
      files: allFiles,
      manifest: buildManifest(allFiles),
      gaps: { target: "filament", gaps: [...gaps, ...perm.gaps, ...aiGaps] },
    };
```

  (`filamentNames`, `CapabilityGap`, `GeneratedFile` are already imported in `generate.ts`.)

- [ ] **Step 4: Run green + REGRESSION** — `pnpm --filter @camis/adapter-filament exec vitest run src/generate.test.ts`; then `pnpm --filter @camis/adapter-filament test` (existing goldens AI-free → unchanged); `git status --short src/__golden__/` empty; `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-filament/src/generate.ts packages/adapter-filament/src/generate.test.ts
git commit -m "feat(adapter-filament): emit AI provider + observer, mark model observed; gap hook collision

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: AI fixture + goldens

**Files:** Create `src/__fixtures__/ai.ts`, `src/ai-golden.test.ts`, golden dir `src/__golden__/ai/`.

- [ ] **Step 1: Fixture** — `src/__fixtures__/ai.ts` (Filament fixtures are `IrBundle`):

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

- [ ] **Step 2: Golden test** — `src/ai-golden.test.ts` (Filament `generate(ir)` takes one arg):

```ts
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "./generate";
import { aiFixture } from "./__fixtures__/ai";

describe("filament ai golden", () => {
  const result = filamentAdapter.generate(aiFixture);
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("observer golden", async () => {
    await expect(c("app/Observers/ArticleObserver.php")).toMatchFileSnapshot("./__golden__/ai/ArticleObserver.php.txt");
  });
  it("provider golden (seed)", async () => {
    await expect(c("app/Ai/Provider.php")).toMatchFileSnapshot("./__golden__/ai/Provider.php.txt");
  });
  it("marks the Article model observed", () => {
    expect(c("app/Models/Article.php")).toContain("ObservedBy([ArticleObserver::class])");
  });
  it("is idempotent", () => {
    expect(filamentAdapter.generate(aiFixture)).toEqual(result);
  });
});
```

- [ ] **Step 3: Generate + INSPECT** — `pnpm --filter @camis/adapter-filament exec vitest run src/ai-golden.test.ts -u`. READ and confirm:
  - `ArticleObserver.php.txt`: `// @camis:generated` marker; `namespace App\Observers;`; `use App\Ai\Provider;` + `use App\Models\Article;`; `creating`/`updating` calling `populateAi`; inside `populateAi`, `if ($isCreate || ($record->isDirty('body'))) {` then `$prompt = str_replace(['{{body}}'], [(string) $record->body], 'Summarize in one line: {{body}}');` then `$record->summary = Provider::generate(null, $prompt);`.
  - `Provider.php.txt`: `namespace App\Ai;`, `public static function generate(?string $model, string $prompt): string`, the offline default, an `ANTHROPIC_API_KEY` comment, NO `@camis:generated` marker (seed).
  - If anything is wrong, STOP and report.

- [ ] **Step 4: Regression** — `pnpm --filter @camis/adapter-filament test` (ALL green); `git status --short src/__golden__/` shows ONLY new files under `ai/`; all existing Filament goldens unchanged. `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-filament/src/__fixtures__/ai.ts packages/adapter-filament/src/ai-golden.test.ts packages/adapter-filament/src/__golden__/ai
git commit -m "test(adapter-filament): AI fixture + observer/provider goldens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Full sweep — Phase 9A closes

- [ ] **Step 1:** `pnpm lint`; `pnpm -r typecheck`; `pnpm -r test` — all green (report counts). Confirm the only new goldens are `src/__golden__/ai/*` and all other adapters' goldens are unchanged. `git status` clean.

  (Do NOT add a live Filament AI boot in this plan — the Filament boot is heavy and the Express gated boot is the behavioral oracle for populate + change-detection; the Filament golden + the well-formed PHP prove emission. With this plan, the AI field is emitted in **all three** targets — 9A's exit criterion is met.)

- [ ] **Step 2: Commit** (only if the sweep produced incidental fixes; otherwise skip).

---

## Self-review (completed by plan author)

**Spec coverage:** §4 Filament — PHP provider seam (seed, offline default, key-from-env comment) + an Eloquent `creating`/`updating` observer (Task 1); change-detection via `$record->isDirty('<snake_col>')` (Task 1 `fireCondition`/`dirty`); prompt assembly via `str_replace` with the prompt as a **PHP-escaped single-quoted literal** — the codegen-injection guard (Task 1 `phpSingleQuoted`); Filament uses snake columns so `{{field}}` maps to `$record-><snakeColumn(field)>` (Task 1). The model is marked `observed` for AI types (Task 2). The hook/AI observer collision is a documented gap (Task 2). §5 golden coverage (Task 3). With this plan the AI field works in all three targets (Express boot is the behavioral oracle).

**Placeholder scan:** No "TBD/TODO". Task 4 Step 2 is an explicit conditional. All emitter code is complete literals.

**Type consistency:** `aiFieldContentTypes`/`hasAiField`/`aiProviderFile`/`emitAiObserver` (Task 1) consumed by `generate.ts` (Task 2). The observer class name `<Model>Observer` (Task 1) is the same path `generate.ts` emits + the `ObservedBy([<Model>Observer::class])` the model emits. The fixture's `onCreateOrUpdate` + `{{body}}` (Task 3) drive the golden's `$isCreate || ($record->isDirty('body'))` block. The collision gap `feature: "aiHookCollision"` (Task 2) matches both its test and the Strapi adapter's identical gap feature name.
