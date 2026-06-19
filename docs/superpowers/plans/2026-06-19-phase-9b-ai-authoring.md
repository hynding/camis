# Phase 9B — ai-authoring (NL → validated IR mutations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@camis/ai-authoring`: turn a natural-language instruction into typed IR mutation ops, apply them, validate against the `ir-core` guardrail, and repair-or-reject — never returning or writing an invalid model.

**Architecture:** A pure core (`mutation` op schema, a total `applyMutations` that also reports op-applicability errors, deterministic prompt builders, and an `author` validate-and-repair loop) depends only on an injected `AiClient` interface. The one real client (`anthropic-client.ts`) is thin and lives behind that interface; unit tests use a sequenced mock — no network. `author` returns the validated `IrDocument` + the ops; it never writes.

**Tech Stack:** TypeScript (strict, ESM), Zod v3, Vitest. Depends on `@camis/ir-schema` (schemas + types), `@camis/ir-core` (`validate`), `@camis/adapter-kernel` (`stableJson`).

**Spec:** `docs/superpowers/specs/2026-06-19-phase-9b-ai-authoring-design.md`.

---

## Conventions

- Package root: `packages/ai-authoring/`. Run a test: `pnpm --filter @camis/ai-authoring exec vitest run src/<file>.test.ts`. Whole package: `… test` / `typecheck` / `lint`.
- No `any` in sources. Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- The package is greenfield (only a `// stub` `index.ts` today) — no goldens, no regression risk.

## Task 0 (prereq, folded into Task 1): dependencies

`packages/ai-authoring/package.json` currently has no `dependencies`. Task 1 adds them. From the repo root (quote the version to avoid zsh globbing):

```bash
pnpm --filter @camis/ai-authoring add "@camis/ir-schema@workspace:*" "@camis/ir-core@workspace:*" "@camis/adapter-kernel@workspace:*" "zod@^3.23.0"
```

## File Structure

| File | Responsibility |
|------|----------------|
| `src/mutation.ts` | The 5-op `mutation` Zod schema + `Mutation`/`AuthoringError` types. |
| `src/apply.ts` | `applyMutations(doc, ops) → { document, errors }` (total; applicability errors). |
| `src/prompts.ts` | `buildSystemPrompt` / `buildUserPrompt` / `buildRepairPrompt` (deterministic). |
| `src/client.ts` | The `AiClient` interface. |
| `src/author.ts` | `author(request)` — the validate-and-repair loop + `AuthorRequest`/`AuthorResult`. |
| `src/anthropic-client.ts` | The real Anthropic-backed `AiClient` (thin; one structural test). |
| `src/index.ts` | Public exports. |

---

## Task 1: Mutation op schema + types (`mutation.ts`)

**Files:** Create `src/mutation.ts`, `src/mutation.test.ts`; modify `package.json` (deps, per Task 0).

- [ ] **Step 1: Add dependencies** — run the Task-0 command. Confirm `package.json` gains the four deps.

- [ ] **Step 2: Write the failing test** — `src/mutation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mutations } from "./mutation";

describe("mutation schema", () => {
  it("parses the five op kinds", () => {
    const ops = [
      { op: "addContentType", contentType: { name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }] } },
      { op: "removeContentType", name: "Old" },
      { op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } },
      { op: "removeField", contentType: "Article", field: "draft" },
      { op: "renameField", contentType: "Article", from: "body", to: "content" },
    ];
    expect(mutations.safeParse(ops).success).toBe(true);
  });
  it("rejects an unknown op and a malformed field", () => {
    expect(mutations.safeParse([{ op: "frobnicate" }]).success).toBe(false);
    expect(mutations.safeParse([{ op: "addField", contentType: "Article", field: { type: "nope", name: "x" } }]).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run red** — `pnpm --filter @camis/ai-authoring exec vitest run src/mutation.test.ts`.

- [ ] **Step 4: Implement** — `src/mutation.ts`:

```ts
import { z } from "zod";
import {
  contentType,
  field,
  fieldName,
  typeName,
  type IrErrorCode,
  type IrErrorLocation,
} from "@camis/ir-schema";

export const mutation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addContentType"), contentType }),
  z.object({ op: z.literal("removeContentType"), name: typeName }),
  z.object({ op: z.literal("addField"), contentType: typeName, field }),
  z.object({ op: z.literal("removeField"), contentType: typeName, field: fieldName }),
  z.object({ op: z.literal("renameField"), contentType: typeName, from: fieldName, to: fieldName }),
]);
export type Mutation = z.infer<typeof mutation>;

export const mutations = z.array(mutation);

// IrError shape, widened so the applier's op-applicability errors coexist with ir-core's IrErrors
// WITHOUT adding an authoring concept to ir-schema's IrErrorCode.
export type AuthoringErrorCode = IrErrorCode | "inapplicable_mutation";
export interface AuthoringError {
  code: AuthoringErrorCode;
  message: string;
  location: IrErrorLocation;
  path: (string | number)[];
}
```

(If `field` inside a `discriminatedUnion` object trips Zod because `field` is itself a refined union, the
nesting is fine — it is a normal object property schema. Do NOT unwrap it.)

- [ ] **Step 5: Run green + commit** — `pnpm --filter @camis/ai-authoring exec vitest run src/mutation.test.ts`; `… typecheck`; `… lint`. Then:

```bash
git add packages/ai-authoring/src/mutation.ts packages/ai-authoring/src/mutation.test.ts packages/ai-authoring/package.json pnpm-lock.yaml
git commit -m "feat(ai-authoring): typed mutation op schema + AuthoringError type

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: The applier (`apply.ts`)

**Files:** Create `src/apply.ts`, `src/apply.test.ts`.

- [ ] **Step 1: Write the failing test** — `src/apply.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { applyMutations } from "./apply";
import type { Mutation } from "./mutation";

const doc: IrDocument = {
  version: 1,
  contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }] }],
  components: [],
} as IrDocument;

describe("applyMutations", () => {
  it("adds a field to an existing content type", () => {
    const ops: Mutation[] = [{ op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } }];
    const r = applyMutations(doc, ops);
    expect(r.errors).toHaveLength(0);
    expect(r.document.contentTypes[0]!.fields.map((f) => f.name)).toEqual(["title", "published"]);
  });
  it("does not mutate the input document (pure)", () => {
    applyMutations(doc, [{ op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } }]);
    expect(doc.contentTypes[0]!.fields).toHaveLength(1);
  });
  it("reports an applicability error for an op on a missing content type", () => {
    const r = applyMutations(doc, [{ op: "addField", contentType: "Ghost", field: { type: "boolean", name: "x" } }]);
    expect(r.errors.some((e) => e.code === "inapplicable_mutation" && e.location.contentType === "Ghost")).toBe(true);
    expect(r.document.contentTypes).toHaveLength(1); // unchanged
  });
  it("renames a field and removes one", () => {
    const r = applyMutations(doc, [
      { op: "addField", contentType: "Article", field: { type: "text", name: "body" } },
      { op: "renameField", contentType: "Article", from: "body", to: "content" },
      { op: "removeField", contentType: "Article", field: "title" },
    ]);
    expect(r.errors).toHaveLength(0);
    expect(r.document.contentTypes[0]!.fields.map((f) => f.name)).toEqual(["content"]);
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/ai-authoring exec vitest run src/apply.test.ts`.

- [ ] **Step 3: Implement** — `src/apply.ts`:

```ts
import type { ContentType, IrDocument } from "@camis/ir-schema";
import type { AuthoringError, Mutation } from "./mutation";

export const applyMutations = (
  doc: IrDocument,
  ops: Mutation[],
): { document: IrDocument; errors: AuthoringError[] } => {
  const out: IrDocument = structuredClone(doc);
  const errors: AuthoringError[] = [];
  const ct = (name: string): ContentType | undefined => out.contentTypes.find((c) => c.name === name);
  const fail = (message: string, location: AuthoringError["location"]): void => {
    errors.push({ code: "inapplicable_mutation", message, location, path: [] });
  };

  for (const op of ops) {
    switch (op.op) {
      case "addContentType":
        if (ct(op.contentType.name)) {
          fail(`content type "${op.contentType.name}" already exists`, { contentType: op.contentType.name });
        } else {
          out.contentTypes.push(op.contentType);
        }
        break;
      case "removeContentType": {
        const i = out.contentTypes.findIndex((c) => c.name === op.name);
        if (i < 0) fail(`content type "${op.name}" does not exist`, { contentType: op.name });
        else out.contentTypes.splice(i, 1);
        break;
      }
      case "addField": {
        const target = ct(op.contentType);
        if (!target) fail(`content type "${op.contentType}" does not exist`, { contentType: op.contentType });
        else target.fields.push(op.field);
        break;
      }
      case "removeField": {
        const target = ct(op.contentType);
        if (!target) {
          fail(`content type "${op.contentType}" does not exist`, { contentType: op.contentType });
          break;
        }
        const i = target.fields.findIndex((f) => f.name === op.field);
        if (i < 0) fail(`field "${op.field}" does not exist on "${op.contentType}"`, { contentType: op.contentType, field: op.field });
        else target.fields.splice(i, 1);
        break;
      }
      case "renameField": {
        const target = ct(op.contentType);
        if (!target) {
          fail(`content type "${op.contentType}" does not exist`, { contentType: op.contentType });
          break;
        }
        const f = target.fields.find((g) => g.name === op.from);
        if (!f) fail(`field "${op.from}" does not exist on "${op.contentType}"`, { contentType: op.contentType, field: op.from });
        else f.name = op.to;
        break;
      }
    }
  }
  return { document: out, errors };
};
```

- [ ] **Step 4: Run green + commit** — `pnpm --filter @camis/ai-authoring exec vitest run src/apply.test.ts`; `… typecheck`; `… lint`.

```bash
git add packages/ai-authoring/src/apply.ts packages/ai-authoring/src/apply.test.ts
git commit -m "feat(ai-authoring): total applyMutations with op-applicability errors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Prompt builders (`prompts.ts`) + the client interface (`client.ts`)

**Files:** Create `src/prompts.ts`, `src/prompts.test.ts`, `src/client.ts`.

- [ ] **Step 1: Write the failing test** — `src/prompts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from "./prompts";

const doc: IrDocument = { version: 1, contentTypes: [{ name: "Article", kind: "collection", fields: [] }], components: [] } as IrDocument;

describe("prompts", () => {
  it("system prompt names the five ops and asks for ops only", () => {
    const s = buildSystemPrompt();
    expect(s).toContain("addContentType");
    expect(s).toContain("renameField");
    expect(s).toContain("JSON array");
  });
  it("user prompt embeds the document (stable JSON) and the instruction", () => {
    const u = buildUserPrompt(doc, "add a published boolean to Article");
    expect(u).toContain('"name": "Article"');
    expect(u).toContain("add a published boolean to Article");
  });
  it("repair prompt includes the rejected ops and the located errors", () => {
    const r = buildRepairPrompt(doc, "x", [{ op: "removeContentType", name: "Ghost" }], [
      { code: "inapplicable_mutation", message: 'content type "Ghost" does not exist', location: { contentType: "Ghost" }, path: [] },
    ]);
    expect(r).toContain("removeContentType");
    expect(r).toContain("inapplicable_mutation");
    expect(r).toContain('content type "Ghost" does not exist');
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/ai-authoring exec vitest run src/prompts.test.ts`.

- [ ] **Step 3: Implement** — `src/client.ts`:

```ts
// The LLM seam. The core depends only on this; the real impl is anthropic-client.ts.
export interface AiClient {
  propose(input: { system: string; user: string }): Promise<unknown>;
}
```

and `src/prompts.ts`:

```ts
import { stableJson } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import type { AuthoringError, Mutation } from "./mutation";

export const buildSystemPrompt = (): string =>
  `You edit a content model by returning a JSON array of mutation ops (and nothing else).
Each op is one of:
- { "op": "addContentType", "contentType": <ContentType> }
- { "op": "removeContentType", "name": <TypeName> }
- { "op": "addField", "contentType": <TypeName>, "field": <Field> }
- { "op": "removeField", "contentType": <TypeName>, "field": <FieldName> }
- { "op": "renameField", "contentType": <TypeName>, "from": <FieldName>, "to": <FieldName> }
A ContentType is { "name", "kind": "collection"|"single", "fields": Field[] }.
A Field is { "type": <one of string|text|richText|email|uid|integer|bigInteger|float|decimal|boolean|enumeration|date|time|dateTime|timestamp|json|media|relation|component|dynamicZone>, "name", ... }.
TypeName is PascalCase; FieldName is camelCase. Return ONLY the JSON array of ops.`;

export const buildUserPrompt = (doc: IrDocument, instruction: string): string =>
  `Current model:
${stableJson(doc)}
Instruction: ${instruction}
Return only the ops array.`;

export const buildRepairPrompt = (
  doc: IrDocument,
  instruction: string,
  rejected: Mutation[],
  errors: AuthoringError[],
): string =>
  `${buildUserPrompt(doc, instruction)}

Your previous ops were rejected:
${stableJson(rejected)}
Fix these errors:
${errors.map((e) => `- [${e.code}] ${e.message}`).join("\n")}
Return corrected ops only.`;
```

- [ ] **Step 4: Run green + commit** — `pnpm --filter @camis/ai-authoring exec vitest run src/prompts.test.ts`; `… typecheck`; `… lint`.

```bash
git add packages/ai-authoring/src/prompts.ts packages/ai-authoring/src/prompts.test.ts packages/ai-authoring/src/client.ts
git commit -m "feat(ai-authoring): deterministic prompt builders + AiClient interface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: The validate-and-repair loop (`author.ts`)

**Files:** Create `src/author.ts`, `src/author.test.ts`.

- [ ] **Step 1: Write the failing test** — `src/author.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { author } from "./author";
import type { AiClient } from "./client";

const doc: IrDocument = {
  version: 1,
  contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }] }],
  components: [],
} as IrDocument;

// A mock client that returns a scripted sequence of proposals (one per propose() call).
const scripted = (...proposals: unknown[]): AiClient => {
  let i = 0;
  return { propose: () => Promise.resolve(proposals[Math.min(i++, proposals.length - 1)]) };
};

describe("author", () => {
  it("returns ok with the applied document on a valid first proposal", async () => {
    const r = await author({ instruction: "add published", document: doc, client: scripted([{ op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } }]) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.contentTypes[0]!.fields.map((f) => f.name)).toContain("published");
      expect(r.ops).toHaveLength(1);
    }
  });
  it("repairs an inapplicable op then succeeds", async () => {
    const r = await author({
      instruction: "add published",
      document: doc,
      client: scripted(
        [{ op: "addField", contentType: "Ghost", field: { type: "boolean", name: "published" } }], // bad: unknown type
        [{ op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } }], // good
      ),
    });
    expect(r.ok).toBe(true);
  });
  it("rejects (ok:false) when the budget is exhausted, never returning an invalid doc", async () => {
    const r = await author({
      instruction: "x",
      document: doc,
      maxRepairs: 1,
      client: scripted([{ op: "addField", contentType: "Ghost", field: { type: "boolean", name: "x" } }]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.code === "inapplicable_mutation")).toBe(true);
  });
  it("feeds a schema-invalid proposal back as a repair", async () => {
    const r = await author({
      instruction: "x",
      document: doc,
      client: scripted(
        [{ op: "frobnicate" }], // schema-invalid
        [{ op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } }],
      ),
    });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/ai-authoring exec vitest run src/author.test.ts`.

- [ ] **Step 3: Implement** — `src/author.ts`:

```ts
import { validate } from "@camis/ir-core";
import type { IrDocument } from "@camis/ir-schema";
import { applyMutations } from "./apply";
import type { AiClient } from "./client";
import { mutations, type AuthoringError, type Mutation } from "./mutation";
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt } from "./prompts";

export interface AuthorRequest {
  instruction: string;
  document: IrDocument;
  client: AiClient;
  maxRepairs?: number;
}

export type AuthorResult =
  | { ok: true; document: IrDocument; ops: Mutation[] }
  | { ok: false; errors: AuthoringError[] };

const schemaErrors = (issues: { message: string; path: (string | number)[] }[]): AuthoringError[] =>
  issues.map((i) => ({ code: "invalid_document", message: i.message, location: {}, path: [...i.path] }));

export const author = async (req: AuthorRequest): Promise<AuthorResult> => {
  const { instruction, document, client } = req;
  const maxRepairs = req.maxRepairs ?? 2;
  const system = buildSystemPrompt();
  let user = buildUserPrompt(document, instruction);

  for (let attempt = 0; ; attempt++) {
    const raw = await client.propose({ system, user });
    const parsed = mutations.safeParse(raw);

    if (!parsed.success) {
      const errors = schemaErrors(parsed.error.issues);
      if (attempt >= maxRepairs) return { ok: false, errors };
      user = buildRepairPrompt(document, instruction, [], errors);
      continue;
    }

    const ops = parsed.data;
    const applied = applyMutations(document, ops);
    const validated = validate(applied.document);
    const errors: AuthoringError[] = [
      ...applied.errors,
      ...(validated.ok ? [] : validated.errors),
    ];

    if (errors.length === 0 && validated.ok) {
      return { ok: true, document: validated.value, ops };
    }
    if (attempt >= maxRepairs) return { ok: false, errors };
    user = buildRepairPrompt(document, instruction, ops, errors);
  }
};
```

- [ ] **Step 4: Run green + commit** — `pnpm --filter @camis/ai-authoring exec vitest run src/author.test.ts`; `… typecheck`; `… lint`.

```bash
git add packages/ai-authoring/src/author.ts packages/ai-authoring/src/author.test.ts
git commit -m "feat(ai-authoring): validate-and-repair authoring loop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: The real Anthropic client (`anthropic-client.ts`)

**Files:** Create `src/anthropic-client.ts`, `src/anthropic-client.test.ts`.

The real `AiClient`: reads `ANTHROPIC_API_KEY` from the environment, calls the Messages API with a single
tool whose input is the ops array (the tool schema is intentionally loose — `mutations.safeParse` in
`author` is the real gate), and returns the tool input. Not behavior-tested (network); one structural
test mocks `fetch`.

- [ ] **Step 1: Write the failing test** — `src/anthropic-client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicClient } from "./anthropic-client";

afterEach(() => vi.restoreAllMocks());

describe("anthropicClient", () => {
  it("builds a tool-use request using the env key and returns the tool input ops", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "tool_use", name: "emit_mutations", input: { ops: [{ op: "removeContentType", name: "X" }] } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ops = await anthropicClient().propose({ system: "sys", user: "usr" });

    expect(ops).toEqual([{ op: "removeContentType", name: "X" }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("api.anthropic.com");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    const body = JSON.parse(init!.body as string);
    expect(body.system).toBe("sys");
    expect(body.tools[0].name).toBe("emit_mutations");
    expect(body.tool_choice).toEqual({ type: "tool", name: "emit_mutations" });
  });
  it("throws when the key is absent", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(anthropicClient().propose({ system: "s", user: "u" })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/ai-authoring exec vitest run src/anthropic-client.test.ts`.

- [ ] **Step 3: Implement** — `src/anthropic-client.ts`:

```ts
import type { AiClient } from "./client";

interface ToolUseBlock {
  type: string;
  input?: { ops?: unknown };
}

// The tool input schema is deliberately permissive — author()'s `mutations.safeParse` is the real gate.
const TOOL = {
  name: "emit_mutations",
  description: "Return the array of mutation ops to apply to the content model.",
  input_schema: {
    type: "object",
    properties: { ops: { type: "array", items: { type: "object" } } },
    required: ["ops"],
  },
};

export const anthropicClient = (opts: { model?: string } = {}): AiClient => ({
  async propose({ system, user }) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? "claude-sonnet-4-6",
        max_tokens: 4096,
        system,
        tools: [TOOL],
        tool_choice: { type: "tool", name: "emit_mutations" },
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content: ToolUseBlock[] };
    const tool = data.content.find((b) => b.type === "tool_use");
    return tool?.input?.ops;
  },
});
```

- [ ] **Step 4: Run green + commit** — `pnpm --filter @camis/ai-authoring exec vitest run src/anthropic-client.test.ts`; `… typecheck`; `… lint`.

```bash
git add packages/ai-authoring/src/anthropic-client.ts packages/ai-authoring/src/anthropic-client.test.ts
git commit -m "feat(ai-authoring): thin Anthropic tool-use client behind AiClient

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Public exports + exit-criteria test + sweep

**Files:** Modify `src/index.ts`; create `src/exit-criteria.test.ts`.

- [ ] **Step 1: Implement exports** — replace `src/index.ts`:

```ts
export { author } from "./author";
export type { AuthorRequest, AuthorResult } from "./author";
export type { AiClient } from "./client";
export { anthropicClient } from "./anthropic-client";
export { mutation, mutations } from "./mutation";
export type { Mutation, AuthoringError } from "./mutation";
export { applyMutations } from "./apply";
```

- [ ] **Step 2: Write the exit-criteria test** — `src/exit-criteria.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validate } from "@camis/ir-core";
import type { IrDocument } from "@camis/ir-schema";
import { author } from "./index";
import type { AiClient } from "./index";

const article: IrDocument = {
  version: 1,
  contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }] }],
  components: [],
} as IrDocument;

const once = (proposal: unknown): AiClient => ({ propose: () => Promise.resolve(proposal) });

describe("9B exit criteria", () => {
  it("an NL instruction yields a mutation that round-trips through validate", async () => {
    const r = await author({
      instruction: "add a published boolean to Article",
      document: article,
      client: once([{ op: "addField", contentType: "Article", field: { type: "boolean", name: "published" } }]),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(validate(r.document).ok).toBe(true); // round-trips through the guardrail
      expect(r.document.contentTypes[0]!.fields.map((f) => f.name)).toEqual(["title", "published"]);
    }
  });
  it("an invalid proposal is rejected, never returned as ok", async () => {
    const r = await author({
      instruction: "break it",
      document: article,
      maxRepairs: 0,
      client: once([{ op: "addField", contentType: "Article", field: { type: "string", name: "title" } }]), // duplicate field → invalid
    });
    expect(r.ok).toBe(false);
  });
});
```

(The duplicate-field case: `validate` runs invariants on the normalized doc; two `title` fields trip
`duplicate_field`, so `author` rejects with `maxRepairs: 0`.)

- [ ] **Step 3: Run green** — `pnpm --filter @camis/ai-authoring test` (all pass); `… typecheck`; `… lint`.

- [ ] **Step 4: Full sweep** — `pnpm lint`; `pnpm -r typecheck`; `pnpm -r test` (report counts; all green — `ai-authoring` is new and imports only stable packages, so no other package changes).

- [ ] **Step 5: Commit**

```bash
git add packages/ai-authoring/src/index.ts packages/ai-authoring/src/exit-criteria.test.ts
git commit -m "feat(ai-authoring): public exports + exit-criteria round-trip test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** D1 typed ops (Task 1) · D2 the 5-op set (Task 1) · D3 `AiClient` seam + real client (Tasks 3, 5) · D4 `validate` guardrail + applier applicability errors, both feeding repair (Tasks 2, 4) · D5 1+2 repair budget, fail-closed (Task 4) · D6 returns validated IR + ops, never writes (Task 4 `AuthorResult`) · D7 well-formedness+applicability not semantic fulfillment (Task 4 — an empty/no-op valid proposal returns `ok`). §3 `author` entry (Task 4); §5 `AuthoringError` (Task 1); §6 repair prompt with errors+ops (Task 3); §7 testing incl. exit-criteria round-trip (Tasks 2–6); §8 exit criteria (Task 6).

**Placeholder scan:** No "TBD/TODO". The system prompt is a complete literal (the field-type list is spelled out). All code steps carry full literals.

**Type consistency:** `Mutation`/`AuthoringError` (Task 1) consumed by apply (2), prompts (3), author (4). `AiClient` (Task 3) consumed by author (4) + implemented by anthropic-client (5). `applyMutations(doc, ops) → { document, errors }` (Task 2) called in author (4). `author(req) → AuthorResult` (Task 4) re-exported (6). The scripted/once mock returns `unknown` matching `AiClient.propose`. `validate(...).value`/`.errors` from `@camis/ir-core` match its `Result<IrDocument>` shape used in author (4).
