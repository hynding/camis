# Phase 7 — Ring 2 Hook Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named, typed Ring 2 hooks to the IR and have both adapters emit, per hook, a typed contract (generated/overwrite), a protected `seed` implementation stub (regen-preserved), and invocation wiring (generated) that calls the impl on publish.

**Architecture:** `ir-schema` gains a `Hook` model on `irDocument.hooks?`. Each adapter emits three regions per hook using the kernel's existing `FileMode` — contract (`overwrite`+marker), impl stub (`seed`, protected), invocation (`overwrite`+marker; Strapi `lifecycles.ts`, Filament Eloquent Observer). A local double-materialize test proves regen preserves the hand-edited stub.

**Tech Stack:** TypeScript (strict, ESM), Vitest, Zod; emitted TS (Strapi v5 lifecycles) and PHP (Laravel 12 observers/interfaces).

**Design spec:** `docs/superpowers/specs/2026-06-18-phase-7-ring2-hook-contract-design.md`

> **Invariant:** hooks are OPTIONAL on `irDocument`; emitters coalesce `doc.hooks ?? []`. Every prior content/permission golden (Strapi + Filament 6A/6B/6C) MUST stay BYTE-IDENTICAL — verify without `-u` in the wiring tasks. The PHP `withMarker` problem: the TS marker is a leading `//` line (invalid before `<?php`), so Filament's generated hook files use a PHP-comment marker placed AFTER `<?php`; the seed stub is unmarked (hand-owned).

---

## File structure

- `packages/ir-schema/src/hooks.ts` (new) — `Hook`/`ShapeField` Zod + types + `HOOK_SCALARS`.
- `packages/ir-schema/src/document.ts` — add `hooks` + a hooks refine; `index.ts` exports.
- `packages/adapter-strapi/src/hooks/{contract,stub,lifecycles,emit}.ts` (new) + `generate.ts` wiring.
- `packages/adapter-filament/src/hooks/{contract,stub,observer,emit}.ts` (new) + `generate.ts` + `model.ts` (`#[ObservedBy]`).
- Regen-preservation tests; golden files; gated-boot workflow extensions.

---

## Task 1: IR hook model (`hooks.ts`)

**Files:** Create `packages/ir-schema/src/hooks.ts`, `packages/ir-schema/src/hooks.test.ts`.

- [ ] **Step 1: Failing test** `packages/ir-schema/src/hooks.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { hook } from "./hooks";

describe("hook schema", () => {
  it("accepts a typed onPublish hook", () => {
    const r = hook.safeParse({
      name: "TransformTitle",
      trigger: "onPublish",
      contentType: "Article",
      input: [{ name: "title", type: "string" }],
      output: [{ name: "title", type: "string" }],
    });
    expect(r.success).toBe(true);
  });
  it("rejects a non-scalar shape type", () => {
    expect(hook.safeParse({ name: "H", trigger: "onPublish", contentType: "Article", input: [{ name: "x", type: "relation" }], output: [{ name: "x", type: "string" }] }).success).toBe(false);
  });
  it("rejects an unknown trigger and empty shapes", () => {
    expect(hook.safeParse({ name: "H", trigger: "onDelete", contentType: "Article", input: [{ name: "x", type: "string" }], output: [{ name: "x", type: "string" }] }).success).toBe(false);
    expect(hook.safeParse({ name: "H", trigger: "onPublish", contentType: "Article", input: [], output: [{ name: "x", type: "string" }] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/ir-schema exec vitest run src/hooks.test.ts`.

- [ ] **Step 3: Implement** `packages/ir-schema/src/hooks.ts`
```ts
import { z } from "zod";
import { fieldName, typeName } from "./identifiers";

export const HOOK_SCALARS = ["string", "text", "integer", "float", "boolean", "dateTime"] as const;
export type HookScalar = (typeof HOOK_SCALARS)[number];

export const shapeField = z.object({ name: fieldName, type: z.enum(HOOK_SCALARS) });
export type ShapeField = z.infer<typeof shapeField>;

export const hook = z.object({
  name: typeName,
  trigger: z.literal("onPublish"),
  contentType: typeName,
  input: z.array(shapeField).min(1),
  output: z.array(shapeField).min(1),
});
export type Hook = z.infer<typeof hook>;
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/ir-schema exec vitest run src/hooks.test.ts`; `pnpm --filter @camis/ir-schema typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/ir-schema/src/hooks.ts packages/ir-schema/src/hooks.test.ts
git commit -m "feat(ir-schema): Ring 2 hook model (typed onPublish hook)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Wire hooks into `irDocument` + refine + exports

**Files:** Modify `packages/ir-schema/src/document.ts`, `packages/ir-schema/src/index.ts`, `packages/ir-schema/src/document.test.ts`.

- [ ] **Step 1: Failing test** — append to `packages/ir-schema/src/document.test.ts`:
```ts
describe("document hooks", () => {
  const base = { version: 1, components: [], contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] }] };
  it("accepts a document with a valid hook", () => {
    expect(irDocument.safeParse({ ...base, hooks: [{ name: "TransformTitle", trigger: "onPublish", contentType: "Article", input: [{ name: "title", type: "string" }], output: [{ name: "title", type: "string" }] }] }).success).toBe(true);
  });
  it("accepts a document with no hooks key (backward compatible)", () => {
    expect(irDocument.safeParse(base).success).toBe(true);
  });
  it("rejects a hook referencing an unknown content type", () => {
    expect(irDocument.safeParse({ ...base, hooks: [{ name: "H", trigger: "onPublish", contentType: "Ghost", input: [{ name: "t", type: "string" }], output: [{ name: "t", type: "string" }] }] }).success).toBe(false);
  });
});
```
(Ensure `irDocument` is imported in `document.test.ts` — it is.)

- [ ] **Step 2: Run red** — `pnpm --filter @camis/ir-schema exec vitest run src/document.test.ts`.

- [ ] **Step 3: Modify `document.ts`** — import the hook schema and add `hooks` + a refine. Replace the `irDocument` definition:
```ts
import { hook } from "./hooks";
// ...
export const irDocument = z
  .object({
    version: z.literal(1),
    contentTypes: z.array(contentType),
    components: z.array(component),
    hooks: z.array(hook).optional(),
  })
  .superRefine((doc, ctx) => {
    const names = new Set(doc.contentTypes.map((ct) => ct.name));
    const seen = new Set<string>();
    (doc.hooks ?? []).forEach((h, i) => {
      if (!names.has(h.contentType)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `hook "${h.name}" references unknown content type "${h.contentType}"`, params: { irCode: "unknown_hook_content_type" }, path: ["hooks", i, "contentType"] });
      }
      if (seen.has(h.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate hook name "${h.name}"`, params: { irCode: "duplicate_hook" }, path: ["hooks", i, "name"] });
      }
      seen.add(h.name);
    });
  });
```
Add the two new `IrErrorCode`s `"unknown_hook_content_type"` and `"duplicate_hook"` to `packages/ir-schema/src/errors.ts`.

- [ ] **Step 4: Exports** — append to `packages/ir-schema/src/index.ts`:
```ts
export { HOOK_SCALARS, hook, shapeField } from "./hooks";
export type { Hook, HookScalar, ShapeField } from "./hooks";
```

- [ ] **Step 5: Run green** — `pnpm --filter @camis/ir-schema test` (whole package; existing document tests still pass — `hooks` is optional), `pnpm --filter @camis/ir-schema typecheck`.

- [ ] **Step 6: Commit**
```bash
git add packages/ir-schema/src
git commit -m "feat(ir-schema): irDocument.hooks (optional) + reference/uniqueness refine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Strapi hook emitters (contract + stub + lifecycles)

**Files:** Create `packages/adapter-strapi/src/hooks/names.ts`, `contract.ts`, `stub.ts`, `lifecycles.ts`, and `*.test.ts`.

- [ ] **Step 1: Names + scalar map** `packages/adapter-strapi/src/hooks/names.ts`
```ts
import type { HookScalar } from "@camis/ir-schema";

// kebab file slug from a PascalCase hook name (TransformTitle -> transform-title).
export const hookSlug = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

export const TS_TYPE: Record<HookScalar, string> = {
  string: "string", text: "string", integer: "number", float: "number", boolean: "boolean", dateTime: "string",
};
```

- [ ] **Step 2: Failing test** `packages/adapter-strapi/src/hooks/contract.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { Hook } from "@camis/ir-schema";
import { emitHookContract } from "./contract";

const h: Hook = { name: "TransformTitle", trigger: "onPublish", contentType: "Article", input: [{ name: "title", type: "string" }], output: [{ name: "title", type: "string" }] };

describe("emitHookContract (strapi)", () => {
  const php = emitHookContract(h);
  it("emits typed input/output and the hook interface, marked generated", () => {
    expect(php).toContain("@camis:generated");
    expect(php).toContain("export interface TransformTitleInput {");
    expect(php).toContain("  title: string;");
    expect(php).toContain("export interface TransformTitleHook {");
    expect(php).toContain("run(input: TransformTitleInput): TransformTitleOutput;");
  });
});
```

- [ ] **Step 3: Run red** — `pnpm --filter @camis/adapter-strapi exec vitest run src/hooks/contract.test.ts`.

- [ ] **Step 4: Implement** `packages/adapter-strapi/src/hooks/contract.ts`
```ts
import { withMarker } from "@camis/adapter-kernel";
import type { Hook, ShapeField } from "@camis/ir-schema";
import { TS_TYPE } from "./names";

const iface = (name: string, fields: ShapeField[]): string =>
  `export interface ${name} {\n${fields.map((f) => `  ${f.name}: ${TS_TYPE[f.type]};`).join("\n")}\n}`;

export const emitHookContract = (h: Hook): string =>
  withMarker(
    `${iface(`${h.name}Input`, h.input)}\n\n${iface(`${h.name}Output`, h.output)}\n\nexport interface ${h.name}Hook {\n  run(input: ${h.name}Input): ${h.name}Output;\n}\n`,
  );
```

- [ ] **Step 5: stub + lifecycles** — `packages/adapter-strapi/src/hooks/stub.ts`
```ts
import type { Hook } from "@camis/ir-schema";
import { hookSlug } from "./names";

// Protected hand-written stub (seed mode, NO generated marker).
export const emitHookStub = (h: Hook): string =>
  `import type { ${h.name}Hook } from "./contracts/${hookSlug(h.name)}.contract";

// Ring 2 hook — hand-written. camis seeds this once and never overwrites it.
export const ${lower(h.name)}: ${h.name}Hook = {
  run(input) {
    // TODO: implement the behavior for "${h.name}".
    return input;
  },
};
`;

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
```
`packages/adapter-strapi/src/hooks/lifecycles.ts`
```ts
import { withMarker } from "@camis/adapter-kernel";
import type { Hook } from "@camis/ir-schema";
import { hookSlug } from "./names";

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

// Generated invocation: on the publish transition, run the hook and apply its output.
export const emitHookLifecycle = (h: Hook): string =>
  withMarker(
    `import { ${lower(h.name)} } from "../../../../hooks/${hookSlug(h.name)}";

export default {
  async beforeUpdate(event: { params: { data?: Record<string, unknown> } }) {
    const { data } = event.params;
    if (data && data.publishedAt) {
      const out = ${lower(h.name)}.run({ ${h.input.map((f) => `${f.name}: data.${f.name} as never`).join(", ")} });
${h.output.map((f) => `      data.${f.name} = out.${f.name};`).join("\n")}
    }
  },
};
`,
  );
```

- [ ] **Step 6: stub + lifecycle tests** `packages/adapter-strapi/src/hooks/emitters.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { Hook } from "@camis/ir-schema";
import { emitHookStub } from "./stub";
import { emitHookLifecycle } from "./lifecycles";

const h: Hook = { name: "TransformTitle", trigger: "onPublish", contentType: "Article", input: [{ name: "title", type: "string" }], output: [{ name: "title", type: "string" }] };

describe("strapi hook stub + lifecycle", () => {
  it("stub is unmarked, imports the contract, returns a typed impl", () => {
    const s = emitHookStub(h);
    expect(s).not.toContain("@camis:generated");
    expect(s).toContain('import type { TransformTitleHook } from "./contracts/transform-title.contract";');
    expect(s).toContain("export const transformTitle: TransformTitleHook = {");
  });
  it("lifecycle is marked, invokes the hook on publish and applies output", () => {
    const l = emitHookLifecycle(h);
    expect(l).toContain("@camis:generated");
    expect(l).toContain('import { transformTitle } from "../../../../hooks/transform-title";');
    expect(l).toContain("if (data && data.publishedAt) {");
    expect(l).toContain("data.title = out.title;");
  });
});
```

- [ ] **Step 7: Run green** — `pnpm --filter @camis/adapter-strapi exec vitest run src/hooks/` ; `pnpm --filter @camis/adapter-strapi typecheck`; `pnpm --filter @camis/adapter-strapi lint`.

- [ ] **Step 8: Commit**
```bash
git add packages/adapter-strapi/src/hooks
git commit -m "feat(adapter-strapi): hook contract, seed stub, and lifecycle invocation emitters

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Strapi generate wiring + golden

**Files:** Create `packages/adapter-strapi/src/hooks/emit.ts`; Modify `packages/adapter-strapi/src/generate.ts`; Create a hooks fixture + golden test.

- [ ] **Step 1: Assembler** `packages/adapter-strapi/src/hooks/emit.ts`
```ts
import type { GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { strapiNames } from "../names";
import { emitHookContract } from "./contract";
import { emitHookLifecycle } from "./lifecycles";
import { hookSlug } from "./names";
import { emitHookStub } from "./stub";

export const emitHookFiles = (doc: IrDocument): GeneratedFile[] => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const files: GeneratedFile[] = [];
  for (const h of doc.hooks ?? []) {
    const ct = byName.get(h.contentType);
    if (!ct) continue;
    const slug = hookSlug(h.name);
    files.push({ path: `src/hooks/contracts/${slug}.contract.ts`, content: emitHookContract(h) });
    files.push({ path: `src/hooks/${slug}.ts`, content: emitHookStub(h), mode: "seed" });
    const names = strapiNames(ct);
    files.push({ path: `src/api/${names.singularName}/content-types/${names.singularName}/lifecycles.ts`, content: emitHookLifecycle(h) });
  }
  return files;
};
```

- [ ] **Step 2: Wire `generate.ts`** — import `emitHookFiles` and add its files to the assembled set. In `strapiAdapter.generate`, change the `allFiles` assembly to include hook files (after `perm.files`):
```ts
import { emitHookFiles } from "./hooks/emit";
// ... after `const allFiles = [...withPerm, ...perm.files];` change to:
    const allFiles = [...withPerm, ...perm.files, ...emitHookFiles(doc)];
```
(`doc` is the normalized document; hooks are read from it.)

- [ ] **Step 3: Hooks fixture** `packages/adapter-strapi/src/__fixtures__/hooks.ts`
```ts
import type { IrDocument } from "@camis/ir-schema";

export const hooksDoc: IrDocument = {
  version: 1,
  contentTypes: [{ name: "Article", kind: "collection", options: { draftPublish: true }, fields: [{ type: "string", name: "title", required: true }] }],
  components: [],
  hooks: [{ name: "TransformTitle", trigger: "onPublish", contentType: "Article", input: [{ name: "title", type: "string" }], output: [{ name: "title", type: "string" }] }],
};
```

- [ ] **Step 4: Golden + regression test** `packages/adapter-strapi/src/hooks/golden.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { hooksDoc } from "../__fixtures__/hooks";

describe("strapi hooks golden", () => {
  const result = strapiAdapter.generate({ document: hooksDoc, roles: [] }, { projectName: "blog" });
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("contract golden", async () => { await expect(c("src/hooks/contracts/transform-title.contract.ts")).toMatchFileSnapshot("./__golden__/transform-title.contract.ts"); });
  it("stub golden (seed mode)", async () => {
    const stub = result.files.find((f) => f.path === "src/hooks/transform-title.ts")!;
    expect(stub.mode).toBe("seed");
    await expect(stub.content).toMatchFileSnapshot("./__golden__/transform-title.stub.ts");
  });
  it("lifecycle golden", async () => { await expect(c("src/api/article/content-types/article/lifecycles.ts")).toMatchFileSnapshot("./__golden__/article.lifecycles.ts"); });
  it("idempotent", () => { expect(strapiAdapter.generate({ document: hooksDoc, roles: [] }, { projectName: "blog" })).toEqual(result); });
});
```

- [ ] **Step 5: Generate + INSPECT + regression** — `pnpm --filter @camis/adapter-strapi exec vitest run src/hooks/golden.test.ts -u`; read the 3 goldens (contract typed + marked; stub unmarked + seed; lifecycle marked + applies output). Then `pnpm --filter @camis/adapter-strapi test` (all green; EXISTING Strapi goldens unchanged — the `blog`/`roundTrip` fixtures have no hooks). `git status --short packages/adapter-strapi/src/__golden__/` must show only NEW `src/hooks/__golden__/*` files; the pre-existing `src/__golden__/*` unchanged. `pnpm --filter @camis/adapter-strapi typecheck`/`lint`.

- [ ] **Step 6: Commit**
```bash
git add packages/adapter-strapi/src/hooks packages/adapter-strapi/src/generate.ts packages/adapter-strapi/src/__fixtures__/hooks.ts
git commit -m "feat(adapter-strapi): emit hook contract/stub/lifecycle; golden + idempotent

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Filament hook emitters (contract + stub + observer)

**Files:** Create `packages/adapter-filament/src/hooks/{names,contract,stub,observer}.ts` + tests.

- [ ] **Step 1: Names + PHP marker + scalar map** `packages/adapter-filament/src/hooks/names.ts`
```ts
import type { HookScalar } from "@camis/ir-schema";

// PHP files can't carry the TS leading-comment marker (invalid before <?php); place it after <?php.
export const PHP_MARKER = "// @camis:generated — do not edit; regenerated by camis";

export const PHP_TYPE: Record<HookScalar, string> = {
  string: "string", text: "string", integer: "int", float: "float", boolean: "bool", dateTime: "string",
};
```

- [ ] **Step 2: Failing test** `packages/adapter-filament/src/hooks/contract.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { Hook } from "@camis/ir-schema";
import { emitHookContract } from "./contract";

const h: Hook = { name: "TransformTitle", trigger: "onPublish", contentType: "Article", input: [{ name: "title", type: "string" }], output: [{ name: "title", type: "string" }] };

describe("emitHookContract (filament)", () => {
  const php = emitHookContract(h);
  it("emits a marked, namespaced interface with phpdoc array shapes", () => {
    expect(php.startsWith("<?php\n" + "// @camis:generated")).toBe(true);
    expect(php).toContain("namespace App\\Hooks\\Contracts;");
    expect(php).toContain("interface TransformTitleHook");
    expect(php).toContain("@param array{title: string} $input");
    expect(php).toContain("@return array{title: string}");
    expect(php).toContain("public function run(array $input): array;");
  });
});
```

- [ ] **Step 3: Run red** — `pnpm --filter @camis/adapter-filament exec vitest run src/hooks/contract.test.ts`.

- [ ] **Step 4: Implement** `packages/adapter-filament/src/hooks/contract.ts`
```ts
import type { Hook, ShapeField } from "@camis/ir-schema";
import { PHP_MARKER, PHP_TYPE } from "./names";

const shape = (fields: ShapeField[]): string =>
  `array{${fields.map((f) => `${f.name}: ${PHP_TYPE[f.type]}`).join(", ")}}`;

export const emitHookContract = (h: Hook): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Hooks\\Contracts;

interface ${h.name}Hook
{
    /**
     * @param ${shape(h.input)} $input
     * @return ${shape(h.output)}
     */
    public function run(array $input): array;
}
`;
```

- [ ] **Step 5: stub + observer** `packages/adapter-filament/src/hooks/stub.ts`
```ts
import type { Hook } from "@camis/ir-schema";

// Protected hand-written stub (seed mode, NO generated marker).
export const emitHookStub = (h: Hook): string => `<?php

declare(strict_types=1);

namespace App\\Hooks;

use App\\Hooks\\Contracts\\${h.name}Hook;

// Ring 2 hook — hand-written. camis seeds this once and never overwrites it.
final class ${h.name} implements ${h.name}Hook
{
    public function run(array $input): array
    {
        // TODO: implement the behavior for "${h.name}".
        return $input;
    }
}
`;
```
`packages/adapter-filament/src/hooks/observer.ts`
```ts
import type { ContentType, Hook } from "@camis/ir-schema";
import { filamentNames, snakeColumn } from "../names";
import { PHP_MARKER } from "./names";

// Generated Eloquent observer: on the publish transition, run the hook and apply output.
export const emitHookObserver = (h: Hook, ct: ContentType): string => {
  const n = filamentNames(ct);
  const inputArr = h.input.map((f) => `'${f.name}' => $record->${snakeColumn(f.name)}`).join(", ");
  const apply = h.output.map((f) => `            $record->${snakeColumn(f.name)} = $out['${f.name}'];`).join("\n");
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Observers;

use App\\Hooks\\${h.name};
use App\\Models\\${n.model};

class ${n.model}Observer
{
    public function updated(${n.model} $record): void
    {
        if ($record->wasChanged('published_at') && $record->published_at !== null) {
            $out = (new ${h.name}())->run([${inputArr}]);
${apply}
            $record->saveQuietly();
        }
    }
}
`;
};
```

- [ ] **Step 6: stub + observer tests** `packages/adapter-filament/src/hooks/emitters.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { ContentType, Hook } from "@camis/ir-schema";
import { emitHookStub } from "./stub";
import { emitHookObserver } from "./observer";

const h: Hook = { name: "TransformTitle", trigger: "onPublish", contentType: "Article", input: [{ name: "title", type: "string" }], output: [{ name: "title", type: "string" }] };
const article: ContentType = { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] } as ContentType;

describe("filament hook stub + observer", () => {
  it("stub is unmarked and implements the contract", () => {
    const s = emitHookStub(h);
    expect(s).not.toContain("@camis:generated");
    expect(s).toContain("final class TransformTitle implements TransformTitleHook");
    expect(s).toContain("return $input;");
  });
  it("observer is marked, fires on publish transition, applies output", () => {
    const o = emitHookObserver(h, article);
    expect(o).toContain("@camis:generated");
    expect(o).toContain("class ArticleObserver");
    expect(o).toContain("if ($record->wasChanged('published_at') && $record->published_at !== null) {");
    expect(o).toContain("$record->title = $out['title'];");
  });
});
```

- [ ] **Step 7: Run green** — `pnpm --filter @camis/adapter-filament exec vitest run src/hooks/`; `pnpm --filter @camis/adapter-filament typecheck`; `lint`.

- [ ] **Step 8: Commit**
```bash
git add packages/adapter-filament/src/hooks
git commit -m "feat(adapter-filament): hook contract, seed stub, and observer invocation emitters

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Filament generate wiring + model `#[ObservedBy]` + golden

**Files:** Create `packages/adapter-filament/src/hooks/emit.ts`; Modify `packages/adapter-filament/src/generate.ts`, `packages/adapter-filament/src/model.ts`; fixture + golden test.

- [ ] **Step 1: Assembler** `packages/adapter-filament/src/hooks/emit.ts`
```ts
import type { GeneratedFile } from "@camis/adapter-kernel";
import type { ContentType, IrDocument } from "@camis/ir-schema";
import { filamentNames } from "../names";
import { emitHookContract } from "./contract";
import { emitHookObserver } from "./observer";
import { emitHookStub } from "./stub";

export interface HookEmission {
  files: GeneratedFile[];
  observedModels: Set<string>; // content type names that gained an observer
}

export const emitHookFiles = (doc: IrDocument): HookEmission => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const files: GeneratedFile[] = [];
  const observedModels = new Set<string>();
  for (const h of doc.hooks ?? []) {
    const ct = byName.get(h.contentType);
    if (!ct) continue;
    files.push({ path: `app/Hooks/Contracts/${h.name}Hook.php`, content: emitHookContract(h) });
    files.push({ path: `app/Hooks/${h.name}.php`, content: emitHookStub(h), mode: "seed" });
    files.push({ path: `app/Observers/${filamentNames(ct).model}Observer.php`, content: emitHookObserver(h, ct as ContentType) });
    observedModels.add(h.contentType);
  }
  return { files, observedModels };
};
```

- [ ] **Step 2: Model `#[ObservedBy]`** — `emitModel` gains an optional flag to add the observer attribute. Modify `packages/adapter-filament/src/model.ts` signature to `emitModel(ct, relations = [], observed = false)`; when `observed`, add `use App\Observers\<Model>Observer;` and the `#[ObservedBy([<Model>Observer::class])]` attribute on the class. Concretely, add near the relation-imports block:
```ts
const observerUse = observed ? `use App\\Observers\\${names.model}Observer;\n` : "";
const observedAttr = observed ? `#[\\Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy([${names.model}Observer::class])]\n` : "";
```
and insert `${observerUse}` into the use block and `${observedAttr}` immediately before `class ${names.model} extends Model`. When `observed=false` (every 6A/6B model), both are empty strings → byte-identical output.

- [ ] **Step 3: Wire `generate.ts`** — import `emitHookFiles`; compute `const hooks = emitHookFiles(doc);` once; pass `observed` to `emitModel` per content type (`hooks.observedModels.has(ct.name)`); append `hooks.files` to the file set. In the content-type loop change the model push to:
```ts
files.push({ path: `app/Models/${names.model}.php`, content: emitModel(ct, rel.methods.get(ct.name) ?? [], hooks.observedModels.has(ct.name)) });
```
and after the permission emission, include `...hooks.files` in `allFiles`.

- [ ] **Step 4: Fixture + golden** `packages/adapter-filament/src/__fixtures__/hooks.ts`
```ts
import type { IrBundle } from "@camis/permissions";

export const hooksBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }, { type: "dateTime", name: "publishedAt" }] }],
    components: [],
    hooks: [{ name: "TransformTitle", trigger: "onPublish", contentType: "Article", input: [{ name: "title", type: "string" }], output: [{ name: "title", type: "string" }] }],
  },
  roles: [],
};
```
`packages/adapter-filament/src/hooks/golden.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { hooksBundle } from "../__fixtures__/hooks";

describe("filament hooks golden", () => {
  const result = filamentAdapter.generate(hooksBundle, { projectName: "blog" });
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("contract golden", async () => { await expect(c("app/Hooks/Contracts/TransformTitleHook.php")).toMatchFileSnapshot("./__golden__/TransformTitleHook.php"); });
  it("stub golden (seed mode)", async () => { const s = result.files.find((f) => f.path === "app/Hooks/TransformTitle.php")!; expect(s.mode).toBe("seed"); await expect(s.content).toMatchFileSnapshot("./__golden__/TransformTitle.stub.php"); });
  it("observer golden", async () => { await expect(c("app/Observers/ArticleObserver.php")).toMatchFileSnapshot("./__golden__/ArticleObserver.php"); });
  it("model carries ObservedBy", async () => { await expect(c("app/Models/Article.php")).toMatchFileSnapshot("./__golden__/Article.observed.php"); });
  it("idempotent", () => { expect(filamentAdapter.generate(hooksBundle, { projectName: "blog" })).toEqual(result); });
});
```

- [ ] **Step 5: Generate + INSPECT + regression** — `... vitest run src/hooks/golden.test.ts -u`; read the 4 goldens (contract marked+phpdoc; stub unmarked+seed; observer marked+wasChanged; model with `#[ObservedBy([ArticleObserver::class])]`). Then `pnpm --filter @camis/adapter-filament test` (all green; the 6A/6B `blog`/`catalog`/`permissions` content goldens UNCHANGED — they have no hooks → `observed=false`). `git status --short packages/adapter-filament/src/__golden__/` shows only NEW `src/hooks/__golden__/*` added; pre-existing goldens untouched. typecheck/lint clean.

- [ ] **Step 6: Commit**
```bash
git add packages/adapter-filament/src/hooks packages/adapter-filament/src/generate.ts packages/adapter-filament/src/model.ts packages/adapter-filament/src/__fixtures__/hooks.ts
git commit -m "feat(adapter-filament): emit hook contract/stub/observer + model ObservedBy; golden

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Regen-preservation test (the decisive proof, both adapters)

Proves the kernel's `seed` mode preserves a hand-edited stub across regeneration while `overwrite` files are rewritten.

**Files:** Create `packages/adapter-strapi/src/hooks/regen.test.ts`, `packages/adapter-filament/src/hooks/regen.test.ts`.

- [ ] **Step 1: Strapi regen test** `packages/adapter-strapi/src/hooks/regen.test.ts`
```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materialize } from "@camis/adapter-kernel";
import { strapiAdapter } from "../generate";
import { hooksDoc } from "../__fixtures__/hooks";

describe("strapi hook regen preservation", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  it("regen preserves the hand-edited seed stub but rewrites the contract", async () => {
    dir = await mkdtemp(join(tmpdir(), "hook-regen-"));
    const gen = () => strapiAdapter.generate({ document: hooksDoc, roles: [] }, { projectName: "blog" });
    await materialize(gen(), dir);
    const stubPath = join(dir, "src/hooks/transform-title.ts");
    const contractPath = join(dir, "src/hooks/contracts/transform-title.contract.ts");
    await writeFile(stubPath, "// HAND EDITED — must survive regen\n");
    await writeFile(contractPath, "// clobbered\n");
    await materialize(gen(), dir); // regenerate
    expect(await readFile(stubPath, "utf8")).toContain("HAND EDITED");      // seed preserved
    expect(await readFile(contractPath, "utf8")).toContain("@camis:generated"); // overwrite regenerated
  });
});
```

- [ ] **Step 2: Filament regen test** `packages/adapter-filament/src/hooks/regen.test.ts` — same shape with `filamentAdapter`/`hooksBundle`, stub `app/Hooks/TransformTitle.php`, contract `app/Hooks/Contracts/TransformTitleHook.php`, asserting the stub keeps "HAND EDITED" and the contract regenerates to contain `@camis:generated`.
```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materialize } from "@camis/adapter-kernel";
import { filamentAdapter } from "../generate";
import { hooksBundle } from "../__fixtures__/hooks";

describe("filament hook regen preservation", () => {
  let dir = "";
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  it("regen preserves the hand-edited seed stub but rewrites the contract", async () => {
    dir = await mkdtemp(join(tmpdir(), "hook-regen-"));
    const gen = () => filamentAdapter.generate(hooksBundle, { projectName: "blog" });
    await materialize(gen(), dir);
    const stubPath = join(dir, "app/Hooks/TransformTitle.php");
    const contractPath = join(dir, "app/Hooks/Contracts/TransformTitleHook.php");
    await writeFile(stubPath, "<?php // HAND EDITED — must survive regen\n");
    await writeFile(contractPath, "// clobbered\n");
    await materialize(gen(), dir);
    expect(await readFile(stubPath, "utf8")).toContain("HAND EDITED");
    expect(await readFile(contractPath, "utf8")).toContain("@camis:generated");
  });
});
```

- [ ] **Step 3: Run** — `pnpm --filter @camis/adapter-strapi exec vitest run src/hooks/regen.test.ts` and `pnpm --filter @camis/adapter-filament exec vitest run src/hooks/regen.test.ts` (both PASS). typecheck/lint.

- [ ] **Step 4: Commit**
```bash
git add packages/adapter-strapi/src/hooks/regen.test.ts packages/adapter-filament/src/hooks/regen.test.ts
git commit -m "test(adapters): regen preserves the protected hook stub (seed), rewrites the contract

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Gated boot reference-impl extensions + sweep

**Files:** Modify `.github/workflows/strapi-boot-smoke.yml` and `.github/workflows/adapter-filament-boot.yml` (add a hook reference-impl step); ensure the boot overlays include a hook (via the existing boot fixtures or a note).

- [ ] **Step 1: Add a hook to the boot fixtures** — so the gated jobs exercise it. In `packages/adapter-strapi/src/__fixtures__/blog.ts` add a `hooks` entry on the document? NO — that would change the Strapi `blog` golden. Instead, add hooks to the BOOT-ONLY bundle: extend `packages/adapter-filament/src/__fixtures__/boot.ts` `document` with a `TransformTitle` `onPublish` hook (boot.ts is not golden-tested), and for Strapi add a boot-only fixture `packages/adapter-strapi/scripts/boot-fixture.ts` exporting `bootDoc` = the `blog` document plus the hook, used by `scripts/boot-smoke.ts` (replace its `blog` import with `bootDoc`). Confirm neither change touches a golden-tested fixture.

- [ ] **Step 2: Filament boot — reference impl + assert** — in `.github/workflows/adapter-filament-boot.yml`, after the overlay + before/with migrate, add a step that REPLACES the seed stub with a real impl and asserts the transform on publish:
```yaml
      - name: Hook reference impl (uppercase title on publish)
        run: |
          cd app
          cat > app/Hooks/TransformTitle.php <<'PHP'
          <?php
          declare(strict_types=1);
          namespace App\Hooks;
          use App\Hooks\Contracts\TransformTitleHook;
          final class TransformTitle implements TransformTitleHook {
              public function run(array $input): array { return ['title' => strtoupper($input['title'])]; }
          }
          PHP
      - name: Migrate + assert hook fires on publish
        run: |
          cd app
          php artisan migrate --force
          php artisan tinker --execute='
            $a = \App\Models\Article::create(["title" => "hello"]);
            $a->published_at = now(); $a->save();
            $fresh = $a->fresh();
            if ($fresh->title !== "HELLO") { fwrite(STDERR, "HOOK MISMATCH title=".$fresh->title."\n"); exit(1); }
            echo "HOOK OK\n";
          '
```
(Place after the permission `Migrate + seed + enforce` step or fold the hook assertion in; keep them as distinct, ordered steps. The observer + `#[ObservedBy]` make the hook fire on the publish transition.)

- [ ] **Step 3: Strapi boot — reference impl + assert** — in `strapi-boot-smoke.yml` (or its `boot-smoke.ts` script), after materialize, overwrite `src/hooks/transform-title.ts` with an uppercasing impl, boot, create+publish an Article via the API, and assert the title is uppercased. (Pin the exact API calls in the boot script; the workflow runs `pnpm --filter @camis/adapter-strapi smoke`.) If the Strapi boot script can't easily exercise publish, document the Filament gated job as the primary hook-enforcement oracle and keep the Strapi assertion to "lifecycles.ts present + project boots".

- [ ] **Step 4: Full sweep** — `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test` (all green; report counts). Confirm `git status` shows NO pre-existing golden changed. (Gated workflows not run locally.)

- [ ] **Step 5: Commit**
```bash
git add .github/workflows packages/adapter-strapi/scripts packages/adapter-filament/src/__fixtures__/boot.ts
git commit -m "ci(adapters): gated boots run a reference hook impl and assert it fires on publish

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** D1 onPublish enum (Task 1) · D2 typed named-field shapes (Tasks 3,5 contract emitters) · D3 three regions w/ FileMode (Tasks 3–6: contract overwrite+marker, stub seed, invocation overwrite+marker) · D4 optional `irDocument.hooks` (Task 2) · D5 Strapi lifecycles / Filament observer (Tasks 3,5) · D6 regen-preservation test (Task 7) · D7 reference impls in gated boots (Task 8). Exit criteria: contract into both targets (Tasks 4,6 goldens); regen preserves protected (Task 7); content goldens unchanged (Tasks 4,6 regression steps); hand impls run (Task 8 gated).

**Placeholder scan:** none — concrete code/PHP/TS throughout. Goldens generated via `-u` then inspected. The PHP-marker decision (marker after `<?php`, stub unmarked) is explicit. Strapi boot publish-exercise is allowed a documented fallback (Task 8 Step 3) since Strapi publish-via-API in the smoke is fiddly — the Filament gated job is the primary hook-runtime oracle.

**Type consistency:** `Hook`/`ShapeField`/`HookScalar`/`hook`/`shapeField`/`HOOK_SCALARS` (Tasks 1–2) consumed by all emitters. `emitHookContract`/`emitHookStub`/`emitHookLifecycle` (strapi) and `emitHookContract`/`emitHookStub`/`emitHookObserver` (filament) consumed by each `hooks/emit.ts` (Tasks 4,6). `emitModel(ct, relations?, observed?)` (Task 6) — the new third param defaults false (6A/6B unaffected). `hookSlug`/`TS_TYPE` (strapi names), `PHP_MARKER`/`PHP_TYPE` (filament names). `materialize`/`withMarker`/`FileMode` from `@camis/adapter-kernel` (unchanged). The seed `mode: "seed"` on stub files is what `materialize` checks for write-once preservation.

**Risk note:** the emitted Strapi lifecycle + Filament observer publish-detection (`data.publishedAt` / `wasChanged('published_at')`) and the exact v5/Laravel runtime behavior are validated only by the gated boot jobs (the oracle); per-commit tests prove the emitted STRUCTURE + the regen-preservation boundary, not the booted runtime.
