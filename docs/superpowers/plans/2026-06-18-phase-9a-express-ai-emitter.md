# Phase 9A (Plan 2 of 3) — Express AI-Field Emitter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@camis/adapter-express` emit working AI-field generation wiring — a protected provider seam + an async populate step woven into the create/update routes — driven by the `ai` IR annotation.

**Architecture:** A new `ai.ts` emitter produces `src/ai/provider.ts` (protected seed; deterministic offline default) and `src/ai/populate.ts` (overwrite; a generated CONFIG + `populateAiFields(type, data, mode)` that assembles the prompt from source columns, honors the trigger + change-detection, and calls the provider best-effort). The route emitter excludes AI columns from the client-writable pick-list and, for AI-bearing content types, makes create/update handlers `async` and calls populate before persisting. Non-AI output stays byte-identical.

**Tech Stack:** TypeScript, Express, Drizzle, Vitest. `@camis/ir-schema` `aiPlaceholders`; `@camis/adapter-kernel` `stableJson`/`withMarker`.

**Spec:** `docs/superpowers/specs/2026-06-18-phase-9a-ai-field-runtime-spec-design.md` (§4 Express, §5).

---

## Conventions

- Package root: `packages/adapter-express/`.
- **Golden guard:** the AI wiring is opt-in per content type, so every existing golden (8A `__golden__/*`, 8B `catalog/*`, 8C `secured/*`) is roles/AI-free and MUST stay byte-identical except where a task explicitly adds new AI goldens. After each task, `git status --short src/__golden__/` shows only the intended changes. NEVER use vitest `-u` except where a task says to generate a named new golden.
- Emitted strings are data (`any` allowed inside them); our `.ts` sources are `any`-free + lint-clean.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|------|----------------|
| `src/ai.ts` (create) | `aiColumnsOf(ct)`, `hasAiField(doc)`, the provider seam constant, `emitAiPopulate(doc)`, `aiFiles(doc)`. |
| `src/routes.ts` (modify) | `aiColumns` option: exclude from pick-list; async + populate woven into create/update (gated → non-AI byte-identical). |
| `src/generate.ts` (modify) | Pass `aiColumns` per content type; emit `aiFiles(doc)` when any content type has an AI field. |
| `src/__fixtures__/ai.ts` (create) | An unsecured Article{body, summary:ai onCreate}. |
| `src/ai-golden.test.ts` (create) | Golden the AI routes + provider + populate + file-listing. |
| `scripts/boot-smoke.ts` (modify) | Boot the AI fixture; assert populate + change-detection (stub provider, no network). |

---

## Task 1: The AI emitter (`ai.ts`)

**Files:** Create `src/ai.ts`, `src/ai.test.ts`.

- [ ] **Step 1: Write the failing test** — `src/ai.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { aiColumnsOf, aiFiles, hasAiField } from "./ai";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "text", name: "body" },
        { type: "text", name: "summary", ai: { prompt: "Sum {{body}}", trigger: "onCreate" } },
      ],
    },
  ],
  components: [],
} as IrDocument;

describe("ai emitter", () => {
  it("hasAiField detects an ai annotation", () => {
    expect(hasAiField(doc)).toBe(true);
    expect(hasAiField({ ...doc, contentTypes: [{ name: "X", kind: "collection", fields: [{ type: "text", name: "a" }] }] } as IrDocument)).toBe(false);
  });
  it("aiColumnsOf returns the snake columns of ai fields", () => {
    expect(aiColumnsOf(doc.contentTypes[0]!)).toEqual(["summary"]);
  });
  it("emits a protected provider seed + an overwrite populate module with the CONFIG", () => {
    const files = aiFiles(doc);
    const provider = files.find((f) => f.path === "src/ai/provider.ts")!;
    expect(provider.mode).toBe("seed");
    expect(provider.content).toContain("export async function generate");
    expect(provider.content).toContain("ANTHROPIC_API_KEY");
    const populate = files.find((f) => f.path === "src/ai/populate.ts")!;
    expect(populate.content).toContain("export async function populateAiFields");
    expect(populate.content).toContain('"Article"');
    expect(populate.content).toContain('"column": "summary"');
    expect(populate.content).toContain('"ph": "body"'); // source placeholder → column mapping
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/ai.test.ts`.

- [ ] **Step 3: Implement** — `src/ai.ts`:

```ts
import { stableJson, withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import { aiPlaceholders, type ContentType, type Field, type IrDocument } from "@camis/ir-schema";
import { snakeColumn } from "./names";

type AiField = Field & { ai?: { model?: string; prompt: string; trigger: string } };

const aiOf = (f: Field): AiField["ai"] | undefined => (f as AiField).ai;

export const aiColumnsOf = (ct: ContentType): string[] =>
  ct.fields.filter((f) => aiOf(f) !== undefined).map((f) => snakeColumn(f.name));

export const hasAiField = (doc: IrDocument): boolean =>
  doc.contentTypes.some((ct) => ct.fields.some((f) => aiOf(f) !== undefined));

// Protected provider seam: deterministic + offline by default so dev/CI need no network or API key.
const PROVIDER = `// camis AI provider — REPLACE FOR PRODUCTION.
// Real impl: read process.env.ANTHROPIC_API_KEY and call the model SDK here.
export async function generate(model: string | undefined, prompt: string): Promise<string> {
  return \`[ai:\${model ?? "default"}] \${prompt.slice(0, 80)}\`;
}
`;

interface AiSource {
  ph: string;
  col: string;
}
interface AiFieldSpec {
  column: string;
  model?: string;
  prompt: string;
  trigger: string;
  sources: AiSource[];
}

const configFor = (doc: IrDocument): Record<string, AiFieldSpec[]> => {
  const cfg: Record<string, AiFieldSpec[]> = {};
  for (const ct of doc.contentTypes) {
    const specs: AiFieldSpec[] = [];
    for (const f of ct.fields) {
      const a = aiOf(f);
      if (!a) continue;
      const sources = aiPlaceholders(a.prompt).map((ph) => ({ ph, col: snakeColumn(ph) }));
      specs.push({
        column: snakeColumn(f.name),
        ...(a.model !== undefined ? { model: a.model } : {}),
        prompt: a.prompt,
        trigger: a.trigger,
        sources,
      });
    }
    if (specs.length > 0) cfg[ct.name] = specs;
  }
  return cfg;
};

const populateModule = (doc: IrDocument): string =>
  withMarker(`import { generate } from "./provider";

interface AiSource {
  ph: string;
  col: string;
}
interface AiFieldSpec {
  column: string;
  model?: string;
  prompt: string;
  trigger: string;
  sources: AiSource[];
}

const CONFIG: Record<string, AiFieldSpec[]> = ${stableJson(configFor(doc))};

// Populate AI fields on a record before it is persisted. Best-effort: a provider error is logged,
// never fatal. On update, a field regenerates only when one of its sources is present in the payload.
export async function populateAiFields(
  type: string,
  data: Record<string, unknown>,
  mode: "create" | "update",
): Promise<Record<string, unknown>> {
  for (const f of CONFIG[type] ?? []) {
    const fires =
      f.trigger === "onCreate"
        ? mode === "create"
        : f.trigger === "onUpdate"
          ? mode === "update"
          : true;
    if (!fires) continue;
    if (mode === "update" && !f.sources.some((s) => s.col in data)) continue;
    let prompt = f.prompt;
    for (const s of f.sources) prompt = prompt.split(\`{{\${s.ph}}}\`).join(String(data[s.col] ?? ""));
    try {
      data[f.column] = await generate(f.model, prompt);
    } catch (err) {
      console.error(\`AI generation failed for \${type}.\${f.column}:\`, err);
    }
  }
  return data;
}
`);

export const aiFiles = (doc: IrDocument): GeneratedFile[] => [
  { path: "src/ai/provider.ts", content: PROVIDER, mode: "seed" },
  { path: "src/ai/populate.ts", content: populateModule(doc) },
];
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/ai.test.ts`; `… typecheck`; `… lint`; `git status --short src/__golden__/` empty.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-express/src/ai.ts packages/adapter-express/src/ai.test.ts
git commit -m "feat(adapter-express): emit AI provider seam + populate module from ai annotations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Weave AI populate into the routes (`routes.ts`)

**Files:** Modify `src/routes.ts`, `src/routes.test.ts`.

The `aiColumns` option excludes those columns from the pick-list and, when non-empty, makes
create/update `async` + calls `populateAiFields`. When empty, output is byte-identical to today.

- [ ] **Step 1: Write the failing test** — add to `src/routes.test.ts`:

```ts
it("without aiColumns, output is unchanged (no populate import)", () => {
  expect(emitRoutes(article, [])).not.toContain("populateAiFields");
});
it("with aiColumns, excludes them from the pick-list and weaves async populate", () => {
  const ts = emitRoutes(article, [], { aiColumns: ["summary"] });
  expect(ts).toContain('import { populateAiFields } from "../ai/populate";');
  expect(ts).toContain('Router.post("/", async (req, res) =>');
  expect(ts).toContain('data = await populateAiFields("Article", data, "create");');
  expect(ts).toContain('data = await populateAiFields("Article", data, "update");');
  expect(ts).not.toContain('"summary"'); // excluded from the pick-list
});
```

(The `article` fixture in `routes.test.ts` is named `Article` and has a `summary`-free field set; the `aiColumns: ["summary"]` exercises exclusion even though `summary` isn't a real column there — exclusion is a set filter, so a non-matching name is simply a no-op and the `not.toContain('"summary"')` holds trivially. If `article` happens to contain a `summary` field, the exclusion is the real assertion.)

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/routes.test.ts`.

- [ ] **Step 3: Implement** — replace `src/routes.ts` with the following. It adds `aiColumns` to `RouteOptions`, computes the gated fragments, excludes AI columns from `cols`, and interpolates `${asyncKw}`/`${dataDecl}`/`${createPop}`/`${updatePop}`/`${aiImport}` into BOTH templates. When `aiColumns` is empty every fragment is empty/`const`, so output is byte-identical to the current file.

```ts
import { withMarker } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { isSupportedField } from "./fields";
import { expressNames, snakeColumn } from "./names";

export interface RouteOptions {
  secured?: boolean;
  aiColumns?: string[];
}

export const emitRoutes = (
  ct: ContentType,
  fkColumns: string[] = [],
  options: RouteOptions = {},
): string => {
  const n = expressNames(ct);
  const t = n.table;
  const typeName = ct.name;
  const aiSet = new Set(options.aiColumns ?? []);
  const cols = [
    ...ct.fields
      .filter((f) => isSupportedField(f.type))
      .map((f) => snakeColumn(f.name))
      .filter((c) => !aiSet.has(c)),
    ...fkColumns,
  ]
    .map((c) => `"${c}"`)
    .join(", ");

  const hasAi = aiSet.size > 0;
  const asyncKw = hasAi ? "async " : "";
  const dataDecl = hasAi ? "let" : "const";
  const aiImport = hasAi ? `\nimport { populateAiFields } from "../ai/populate";` : "";
  const createPop = hasAi
    ? `\n  data = await populateAiFields("${typeName}", data, "create");`
    : "";
  const updatePop = hasAi
    ? `\n  data = await populateAiFields("${typeName}", data, "update");`
    : "";

  if (!options.secured) {
    return withMarker(`import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { ${t} } from "../db/schema";${aiImport}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

export const ${t}Router = Router();

${t}Router.get("/", (_req, res) => {
  res.json(db.select().from(${t}).all());
});

${t}Router.get("/:id", (req, res) => {
  const row = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(row);
});

${t}Router.post("/", ${asyncKw}(req, res) => {
  ${dataDecl} data = pick(req.body, [${cols}]);${createPop}
  const row = db.insert(${t}).values(data).returning().get();
  res.status(201).json(row);
});

${t}Router.patch("/:id", ${asyncKw}(req, res) => {
  ${dataDecl} data = pick(req.body, [${cols}]);${updatePop}
  const row = db.update(${t}).set(data).where(eq(${t}.id, Number(req.params.id))).returning().get();
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(row);
});

${t}Router.delete("/:id", (req, res) => {
  db.delete(${t}).where(eq(${t}.id, Number(req.params.id))).run();
  res.status(204).end();
});
`);
  }

  return withMarker(`import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { ${t} } from "../db/schema";
import { authorizeAction, recordAllowed, filterRead, stripWrites, roleOf } from "../permissions/enforce";${aiImport}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  return out;
}

export const ${t}Router = Router();

${t}Router.get("/", (req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "read")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const all = db.select().from(${t}).all().filter((row) => recordAllowed(req, "${typeName}", row));
  const sort = String(req.query._sort ?? "id");
  const order = String(req.query._order ?? "ASC").toUpperCase() === "DESC" ? -1 : 1;
  all.sort((a, b) => (a[sort as keyof typeof a] > b[sort as keyof typeof b] ? order : -order));
  const start = Number(req.query._start ?? 0);
  const end = Number(req.query._end ?? all.length);
  const page = all.slice(start, end).map((row) => filterRead(req, "${typeName}", row));
  res.setHeader("Content-Range", \`${t} \${start}-\${Math.max(start, end - 1)}/\${all.length}\`);
  res.json(page);
});

${t}Router.get("/:id", (req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "read")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const row = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!row || !recordAllowed(req, "${typeName}", row)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(filterRead(req, "${typeName}", row));
});

${t}Router.post("/", ${asyncKw}(req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "create")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const proposed = pick(req.body, [${cols}]);
  ${dataDecl} data = stripWrites(req, "${typeName}", proposed, proposed);${createPop}
  const row = db.insert(${t}).values(data).returning().get();
  res.status(201).json(filterRead(req, "${typeName}", row));
});

${t}Router.patch("/:id", ${asyncKw}(req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "update")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const existing = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!existing || !recordAllowed(req, "${typeName}", existing)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const incoming = pick(req.body, [${cols}]);
  ${dataDecl} data = stripWrites(req, "${typeName}", { ...existing, ...incoming }, incoming);${updatePop}
  const row = db.update(${t}).set(data).where(eq(${t}.id, Number(req.params.id))).returning().get();
  res.json(filterRead(req, "${typeName}", row));
});

${t}Router.delete("/:id", (req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "delete")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const existing = db.select().from(${t}).where(eq(${t}.id, Number(req.params.id))).get();
  if (!existing || !recordAllowed(req, "${typeName}", existing)) {
    res.status(404).json({ error: "not found" });
    return;
  }
  db.delete(${t}).where(eq(${t}.id, Number(req.params.id))).run();
  res.json({ id: Number(req.params.id) });
});
`);
};
```

- [ ] **Step 4: Run green + REGRESSION** — `pnpm --filter @camis/adapter-express exec vitest run src/routes.test.ts`; then `pnpm --filter @camis/adapter-express test`. The 8A/8B/8C route goldens (all with empty `aiColumns`) MUST stay byte-identical: `git status --short src/__golden__/` empty. `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-express/src/routes.ts packages/adapter-express/src/routes.test.ts
git commit -m "feat(adapter-express): weave async AI populate into create/update routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire AI emission into `generate.ts`

**Files:** Modify `src/generate.ts`, `src/generate.test.ts`.

- [ ] **Step 1: Write the failing test** — add to `src/generate.test.ts`:

```ts
it("emits AI provider + populate and AI-aware routes when a field has an ai annotation", () => {
  const bundle = { document: { version: 1, contentTypes: [
    { name: "Article", kind: "collection", fields: [
      { type: "text", name: "body" },
      { type: "text", name: "summary", ai: { prompt: "Sum {{body}}", trigger: "onCreate" } },
    ] },
  ], components: [] }, roles: [] } as never;
  const r = expressAdapter.generate(bundle, { projectName: "blog" });
  const paths = r.files.map((f) => f.path);
  expect(paths).toContain("src/ai/provider.ts");
  expect(paths).toContain("src/ai/populate.ts");
  const routes = r.files.find((f) => f.path === "src/routes/articles.ts")!.content;
  expect(routes).toContain("populateAiFields");
});
it("emits no AI files when no field has an ai annotation", () => {
  const r = expressAdapter.generate({ document: { version: 1, contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "text", name: "body" }] }], components: [] }, roles: [] } as never, { projectName: "blog" });
  expect(r.files.some((f) => f.path.startsWith("src/ai/"))).toBe(false);
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/generate.test.ts`.

- [ ] **Step 3: Implement** — in `src/generate.ts`:
  1. Add imports:

```ts
import { aiColumnsOf, aiFiles, hasAiField } from "./ai";
```

  2. In the `doc.contentTypes.forEach((ct) => { ... })` loop, change the route push to pass `aiColumns`:

```ts
      files.push({
        path: `src/routes/${expressNames(ct).table}.ts`,
        content: emitRoutes(ct, fkNames(fk), { secured, aiColumns: aiColumnsOf(ct) }),
      });
```

  3. After `files.push(camisSchemaFile(doc));` (and independent of the `if (secured)` block), add:

```ts
    if (hasAiField(doc)) files.push(...aiFiles(doc));
```

- [ ] **Step 4: Run green + REGRESSION** — `pnpm --filter @camis/adapter-express exec vitest run src/generate.test.ts`; then `pnpm --filter @camis/adapter-express test`. All existing goldens (no AI fields) byte-identical — `git status --short src/__golden__/` empty. `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-express/src/generate.ts packages/adapter-express/src/generate.test.ts
git commit -m "feat(adapter-express): emit AI files + AI-aware routes when the doc has an ai field

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: AI fixture + goldens

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

- [ ] **Step 2: Golden test** — `src/ai-golden.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expressAdapter } from "./generate";
import { aiFixture } from "./__fixtures__/ai";

describe("ai golden", () => {
  const result = expressAdapter.generate(aiFixture, { projectName: "blog" });
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("articles routes golden (async populate, summary excluded from pick-list)", async () => {
    await expect(c("src/routes/articles.ts")).toMatchFileSnapshot("./__golden__/ai/articles.routes.ts.txt");
  });
  it("provider seam golden (seed)", async () => {
    await expect(c("src/ai/provider.ts")).toMatchFileSnapshot("./__golden__/ai/provider.ts.txt");
  });
  it("populate module golden", async () => {
    await expect(c("src/ai/populate.ts")).toMatchFileSnapshot("./__golden__/ai/populate.ts.txt");
  });
  it("file-listing golden", async () => {
    await expect(result.files.map((f) => `${f.mode ?? "overwrite"} ${f.path}`).sort().join("\n")).toMatchFileSnapshot("./__golden__/ai/file-listing.txt");
  });
  it("is idempotent", () => {
    expect(expressAdapter.generate(aiFixture, { projectName: "blog" })).toEqual(result);
  });
});
```

- [ ] **Step 3: Generate + INSPECT** — `pnpm --filter @camis/adapter-express exec vitest run src/ai-golden.test.ts -u`. READ and confirm:
  - `articles.routes.ts.txt`: `import { populateAiFields } from "../ai/populate";`; `post("/", async (req, res)`; `let data = pick(req.body, ["title", "body"]);` (NO `"summary"`); `data = await populateAiFields("Article", data, "create");` and `..., "update");`.
  - `provider.ts.txt`: `export async function generate`, the offline default, `ANTHROPIC_API_KEY` comment; NO `@camis:generated` marker (seed).
  - `populate.ts.txt`: the `CONFIG` with `"Article"` → `{ "column": "summary", "prompt": "...", "trigger": "onCreateOrUpdate", "sources": [{ "ph": "body", "col": "body" }] }`; the `populateAiFields` function.
  - `file-listing.txt`: includes `seed src/ai/provider.ts` + `overwrite src/ai/populate.ts`.

- [ ] **Step 4: Regression** — `pnpm --filter @camis/adapter-express test`; `git status --short src/__golden__/` shows ONLY new files under `ai/`; all 8A/8B/8C goldens unchanged. `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-express/src/__fixtures__/ai.ts packages/adapter-express/src/ai-golden.test.ts packages/adapter-express/src/__golden__/ai
git commit -m "test(adapter-express): AI fixture + provider/populate/routes goldens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Gated boot proves AI populate (stub, offline)

**Files:** Modify `packages/adapter-express/scripts/boot-smoke.ts`.

Boot the AI fixture (unsecured) on the sqlite leg and assert: create → `summary` populated by the stub;
update `title` only → `summary` unchanged (no source changed); update `body` → `summary` regenerates.
No network / `ANTHROPIC_API_KEY`.

- [ ] **Step 1: Implement** — in `scripts/boot-smoke.ts`, add an AI boot section guarded to the sqlite leg
  (it materializes a SECOND project into a fresh temp dir so it does not disturb the secured boot). Add
  near the top imports: `import { aiFixture } from "../src/__fixtures__/ai";`. Then, just before the final
  `console.log(...PASS...)`, add:

```ts
  if (dialect === "sqlite") {
    const aiDir = await mkdtemp(join(tmpdir(), "camis-express-ai-"));
    process.env.DB_FILE_NAME = join(aiDir, "data.db");
    let aiProc: ChildProcess | undefined;
    try {
      await materialize(expressAdapterFor("sqlite").generate(aiFixture, { projectName: "ai" }), aiDir);
      if (spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: aiDir, stdio: "inherit" }).status !== 0) fail("ai install failed");
      if (spawnSync("npm", ["run", "db:push", "--", "--force"], { cwd: aiDir, stdio: "inherit" }).status !== 0) fail("ai db:push failed");
      aiProc = spawn("npm", ["start"], { cwd: aiDir, stdio: "inherit", env: { ...process.env, PORT: "3211" } });
      const aiRoot = "http://127.0.0.1:3211/api/articles";
      if (!(await waitForServer(aiRoot, 30_000))) fail("ai server did not start");
      const created = await fetch(aiRoot, { method: "POST", headers, body: JSON.stringify({ title: "t", body: "the original body" }) });
      const createdBody = (await created.json()) as { id: number; summary?: string };
      if (created.status !== 201 || !createdBody.summary?.startsWith("[ai:")) fail(`ai create did not populate summary: ${JSON.stringify(createdBody)}`);
      const id = createdBody.id;
      const firstSummary = createdBody.summary;
      // update title only → summary unchanged (no source changed)
      await fetch(`${aiRoot}/${id}`, { method: "PATCH", headers, body: JSON.stringify({ title: "t2" }) });
      const afterTitle = (await (await fetch(`${aiRoot}/${id}`)).json()) as { summary?: string };
      if (afterTitle.summary !== firstSummary) fail("summary regenerated on a non-source update");
      // update body → summary regenerates
      await fetch(`${aiRoot}/${id}`, { method: "PATCH", headers, body: JSON.stringify({ body: "a different body entirely" }) });
      const afterBody = (await (await fetch(`${aiRoot}/${id}`)).json()) as { summary?: string };
      if (!afterBody.summary?.includes("a different body")) fail(`summary did not regenerate on a source update: ${JSON.stringify(afterBody)}`);
      console.log("AI POPULATE OK");
    } finally {
      aiProc?.kill("SIGTERM");
      await rm(aiDir, { recursive: true, force: true });
    }
  }

  console.log(`EXPRESS SECURED BOOT SMOKE PASS (${dialect})`);
```

  (Replace the existing final `console.log(...PASS...)` line with the block above ending in that same
  log. `mkdtemp`, `rm`, `tmpdir`, `join`, `spawn`, `spawnSync`, `materialize`, `waitForServer`,
  `headers`, `fail`, `ChildProcess` are all already imported/defined in the script.)

- [ ] **Step 2: Typecheck the script** — `pnpm --filter @camis/adapter-express exec tsc --noEmit --module ESNext --moduleResolution Bundler --target ESNext --strict --skipLibCheck scripts/boot-smoke.ts` (expect no output).

- [ ] **Step 3: Full sweep** — `pnpm lint`; `pnpm -r typecheck`; `pnpm -r test` (report counts; all green). Confirm the only new goldens are `src/__golden__/ai/*`. Do NOT run the gated workflow locally.

- [ ] **Step 4: Commit**

```bash
git add packages/adapter-express/scripts/boot-smoke.ts
git commit -m "ci(adapter-express): gated boot proves offline AI populate + change-detection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** §4 provider seam (seed, offline default, key-from-env comment) — Task 1. Generated populate wiring with trigger + change-detection + best-effort — Task 1 (`populateModule`) + Task 2 (routes). Prompt assembly from sources — Task 1. AI field excluded from the client-writable pick-list — Task 2. Opt-in per content type, non-AI byte-identical — Tasks 2, 3 (regression guards). §5 golden + offline gated boot with the three trigger/change-detection assertions — Tasks 4, 5. (Admin read-only for AI fields and the Strapi/Filament emitters are Plan 3.)

**Placeholder scan:** No "TBD/TODO". Task 2's note about the `article` fixture is a conditional clarification, not a placeholder. All emitter code is complete literals.

**Type consistency:** `aiColumnsOf`/`hasAiField`/`aiFiles` (Task 1) consumed by `generate.ts` (Task 3). `RouteOptions.aiColumns` (Task 2) is set by `generate.ts` via `aiColumnsOf(ct)` (Task 3). The populate CONFIG shape (`column`/`model?`/`prompt`/`trigger`/`sources:[{ph,col}]`, Task 1) matches the `populateAiFields` consumer in the same emitted module. The fixture's `onCreateOrUpdate` trigger + `{{body}}` placeholder (Task 4) drive the boot's create-populates + source-change-regenerates assertions (Task 5).
