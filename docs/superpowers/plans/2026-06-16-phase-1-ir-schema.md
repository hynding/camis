# Phase 1 — IR Schema & Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the neutral, typed, validated IR content model across `@camis/ir-schema` (vocabulary + node-local validation) and `@camis/ir-core` (cross-graph semantics + normalization).

**Architecture:** Zod is the single source of truth — TS types via `z.infer`, runtime validation with located errors. `ir-schema` enforces everything decidable within one content-type/component node (identifiers, cardinality, per-field cross-field rules) via Zod + `superRefine`; `ir-core` enforces graph-wide invariants (references resolve, global uniqueness, acyclic component nesting) and normalizes (defaults + derived names, idempotent). Validation returns `Result<T>` and never throws for invalid input.

**Tech Stack:** TypeScript (strict, ESM, `moduleResolution: Bundler` — extensionless relative imports), Zod, Vitest.

**Reference:** `docs/superpowers/specs/2026-06-16-phase-1-ir-schema-design.md` (decisions D1–D11, rules S1–S10 / C1–C5).

**Conventions for every commit step:** end the message with the trailer
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Use `import type` for type-only
imports (`verbatimModuleSyntax` is on). Relative imports are extensionless.

---

## File structure

**`packages/ir-schema/src/`**
- `errors.ts` — `IrErrorCode`, `IrError`, `Result<T>`, `ok`/`fail` helpers.
- `identifiers.ts` — name regexes + Zod string schemas (`typeName`, `fieldName`).
- `fields.ts` — `FieldType`, `RelationKind`, all field variant objects, the `field` and `componentField` unions with per-field `superRefine`.
- `document.ts` — `contentType`, `component`, `irDocument` schemas + node-level `superRefine`; inferred types.
- `parse.ts` — `parseDocument(input)`; `ZodIssue → IrError` mapping.
- `capability.ts` — capability descriptor / gap report types.
- `index.ts` — public surface.

**`packages/ir-core/src/`**
- `inflect.ts` — `humanize`, `pluralize`, `snakeCase` (deterministic).
- `normalize.ts` — `normalize(doc)`.
- `invariants.ts` — `validateInvariants(doc)` (C1–C5).
- `validate.ts` — `validate(input)` orchestration.
- `__fixtures__/valid-blog.ts` — the exit-criteria multi-type fixture.
- `index.ts` — public surface.

Run a single test file with:
`pnpm --filter @camis/ir-schema exec vitest run src/<file>.test.ts`
Typecheck a package with: `pnpm --filter @camis/ir-schema typecheck`

---

## Task 1: ir-schema errors & Result

**Files:**
- Modify: `packages/ir-schema/package.json` (add `zod`)
- Create: `packages/ir-schema/src/errors.ts`
- Test: `packages/ir-schema/src/errors.test.ts`

- [ ] **Step 1: Add zod**

Run: `pnpm --filter @camis/ir-schema add zod`

- [ ] **Step 2: Write the failing test**

`packages/ir-schema/src/errors.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { fail, ok, type IrError } from "./errors";

describe("Result helpers", () => {
  it("ok wraps a value", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });

  it("fail wraps errors", () => {
    const err: IrError = { code: "invalid_document", message: "bad", location: {}, path: [] };
    expect(fail([err])).toEqual({ ok: false, errors: [err] });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/errors.test.ts`
Expected: FAIL — cannot resolve `./errors`.

- [ ] **Step 4: Write minimal implementation**

`packages/ir-schema/src/errors.ts`
```ts
export type IrErrorCode =
  | "invalid_document"
  | "invalid_identifier"
  | "empty_enumeration"
  | "invalid_min_max"
  | "enum_default_not_member"
  | "duplicate_field"
  | "empty_dynamic_zone"
  | "reserved_field_name"
  | "invalid_default_type"
  | "unknown_uid_target"
  | "unknown_relation_target"
  | "unknown_component_ref"
  | "duplicate_content_type_name"
  | "duplicate_component_name"
  | "cyclic_component_reference"
  | "inverse_field_collision";

export interface IrErrorLocation {
  contentType?: string;
  component?: string;
  field?: string;
  rule?: string;
}

export interface IrError {
  code: IrErrorCode;
  message: string;
  location: IrErrorLocation;
  path: (string | number)[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: IrError[] };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = (errors: IrError[]): Result<never> => ({ ok: false, errors });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/errors.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/ir-schema
git commit -m "feat(ir-schema): error codes and Result type

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Identifier schemas

**Files:**
- Create: `packages/ir-schema/src/identifiers.ts`
- Test: `packages/ir-schema/src/identifiers.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/ir-schema/src/identifiers.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { fieldName, typeName } from "./identifiers";

describe("typeName (PascalCase)", () => {
  it.each(["Article", "BlogPost", "A1"])("accepts %s", (n) => {
    expect(typeName.safeParse(n).success).toBe(true);
  });
  it.each(["article", "1Bad", "Blog Post", ""])("rejects %s", (n) => {
    expect(typeName.safeParse(n).success).toBe(false);
  });
});

describe("fieldName (camelCase)", () => {
  it.each(["title", "blogPost", "a1"])("accepts %s", (n) => {
    expect(fieldName.safeParse(n).success).toBe(true);
  });
  it.each(["Title", "1bad", "blog_post", ""])("rejects %s", (n) => {
    expect(fieldName.safeParse(n).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/identifiers.test.ts`
Expected: FAIL — cannot resolve `./identifiers`.

- [ ] **Step 3: Write minimal implementation**

`packages/ir-schema/src/identifiers.ts`
```ts
import { z } from "zod";

export const TYPE_NAME_PATTERN = /^[A-Z][A-Za-z0-9]*$/;
export const FIELD_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;

export const typeName = z.string().regex(TYPE_NAME_PATTERN, "must be PascalCase");
export const fieldName = z.string().regex(FIELD_NAME_PATTERN, "must be camelCase");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/identifiers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ir-schema
git commit -m "feat(ir-schema): identifier schemas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Scalar field variants + per-field refinements

**Files:**
- Create: `packages/ir-schema/src/fields.ts`
- Test: `packages/ir-schema/src/fields.test.ts`

Builds the scalar half of the discriminated union plus the per-field `superRefine`
(min≤max, enum default∈values). Structural/relational variants come in Task 4.

- [ ] **Step 1: Write the failing test**

`packages/ir-schema/src/fields.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { field } from "./fields";

const parse = (v: unknown) => field.safeParse(v);

describe("scalar fields", () => {
  it("accepts a string field with constraints", () => {
    expect(parse({ type: "string", name: "title", required: true, maxLength: 200 }).success).toBe(true);
  });

  it("rejects minLength > maxLength (S3)", () => {
    expect(parse({ type: "string", name: "title", minLength: 5, maxLength: 2 }).success).toBe(false);
  });

  it("accepts an enumeration with values and a member default", () => {
    expect(parse({ type: "enumeration", name: "status", values: ["draft", "live"], default: "draft" }).success).toBe(true);
  });

  it("rejects an empty enumeration (S2)", () => {
    expect(parse({ type: "enumeration", name: "status", values: [] }).success).toBe(false);
  });

  it("rejects an enum default that is not a member (S4)", () => {
    expect(parse({ type: "enumeration", name: "status", values: ["draft"], default: "live" }).success).toBe(false);
  });

  it("rejects min > max on a numeric field (S3)", () => {
    expect(parse({ type: "integer", name: "rank", min: 10, max: 1 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/fields.test.ts`
Expected: FAIL — cannot resolve `./fields`.

- [ ] **Step 3: Write minimal implementation**

`packages/ir-schema/src/fields.ts`
```ts
import { z } from "zod";
import { fieldName, typeName } from "./identifiers";

export const FIELD_TYPES = [
  "string", "text", "richText", "email", "uid",
  "integer", "bigInteger", "float", "decimal",
  "boolean", "enumeration",
  "date", "time", "dateTime", "timestamp",
  "json", "media",
  "relation", "component", "dynamicZone",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const RELATION_KINDS = ["oneToOne", "oneToMany", "manyToOne", "manyToMany"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

const common = { name: fieldName, required: z.boolean().optional() };
const len = { minLength: z.number().int().nonnegative().optional(), maxLength: z.number().int().nonnegative().optional() };
const bound = { min: z.number().optional(), max: z.number().optional() };

const textLike = (type: "string" | "text" | "richText" | "email") =>
  z.object({ type: z.literal(type), ...common, unique: z.boolean().optional(), ...len, default: z.string().optional() });

const numeric = (type: "integer" | "bigInteger" | "float" | "decimal") =>
  z.object({ type: z.literal(type), ...common, unique: z.boolean().optional(), ...bound, default: z.number().optional() });

const temporal = (type: "date" | "time" | "dateTime" | "timestamp") =>
  z.object({ type: z.literal(type), ...common, default: z.string().optional() });

const uidField = z.object({ type: z.literal("uid"), ...common, unique: z.boolean().optional(), ...len, targetField: fieldName.optional(), default: z.string().optional() });
const booleanField = z.object({ type: z.literal("boolean"), ...common, default: z.boolean().optional() });
const enumerationField = z.object({ type: z.literal("enumeration"), ...common, values: z.array(z.string()).min(1), default: z.string().optional() });
const jsonField = z.object({ type: z.literal("json"), ...common });
const mediaField = z.object({
  type: z.literal("media"), ...common,
  multiple: z.boolean().optional(),
  allowedTypes: z.array(z.enum(["image", "video", "audio", "file"])).optional(),
});

// Structural variants (defined fully in Task 4); placeholders kept out of the union until then.
export const SCALAR_VARIANTS = [
  textLike("string"), textLike("text"), textLike("richText"), textLike("email"),
  uidField, numeric("integer"), numeric("bigInteger"), numeric("float"), numeric("decimal"),
  booleanField, enumerationField, temporal("date"), temporal("time"), temporal("dateTime"),
  temporal("timestamp"), jsonField, mediaField,
] as const;

// Per-field cross-field refinement (S2/S3/S4). Applied after the union so discriminatedUnion
// keeps precise discriminator errors (its members must be plain ZodObjects).
export const perFieldRefine = (f: z.infer<(typeof SCALAR_VARIANTS)[number]>, ctx: z.RefinementCtx) => {
  const anyF = f as Record<string, unknown>;
  if (typeof anyF.minLength === "number" && typeof anyF.maxLength === "number" && anyF.minLength > anyF.maxLength) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "minLength must be <= maxLength", params: { irCode: "invalid_min_max" }, path: ["minLength"] });
  }
  if (typeof anyF.min === "number" && typeof anyF.max === "number" && anyF.min > anyF.max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "min must be <= max", params: { irCode: "invalid_min_max" }, path: ["min"] });
  }
  if (f.type === "enumeration" && f.default !== undefined && !f.values.includes(f.default)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "default must be one of values", params: { irCode: "enum_default_not_member" }, path: ["default"] });
  }
};

export const field = z.discriminatedUnion("type", [...SCALAR_VARIANTS]).superRefine(perFieldRefine);

// Re-exported so Task 4 can extend the union.
export { typeName };
```

*Note:* the `field` export here covers only scalars; Task 4 replaces it with the full union
(scalars + relation/component/dynamicZone). The scalar tests above stay green.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/fields.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @camis/ir-schema typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/ir-schema
git commit -m "feat(ir-schema): scalar field variants with cross-field refinements

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Structural field variants + `field` / `componentField` unions

**Files:**
- Modify: `packages/ir-schema/src/fields.ts`
- Test: `packages/ir-schema/src/fields.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

Append to `packages/ir-schema/src/fields.test.ts`:
```ts
import { componentField } from "./fields";

describe("structural fields", () => {
  it("accepts a relation field", () => {
    expect(field.safeParse({ type: "relation", name: "author", relationKind: "manyToOne", target: "User", inverse: "articles" }).success).toBe(true);
  });

  it("accepts a component field", () => {
    expect(field.safeParse({ type: "component", name: "seo", component: "SeoMeta", repeatable: false }).success).toBe(true);
  });

  it("accepts a dynamic zone at field level", () => {
    expect(field.safeParse({ type: "dynamicZone", name: "blocks", components: ["Hero"] }).success).toBe(true);
  });

  it("rejects an empty dynamic zone (S7)", () => {
    expect(field.safeParse({ type: "dynamicZone", name: "blocks", components: [] }).success).toBe(false);
  });

  it("componentField rejects a dynamic zone (S6/D6)", () => {
    expect(componentField.safeParse({ type: "dynamicZone", name: "blocks", components: ["Hero"] }).success).toBe(false);
  });

  it("componentField accepts a relation", () => {
    expect(componentField.safeParse({ type: "relation", name: "author", relationKind: "oneToOne", target: "User" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/fields.test.ts`
Expected: FAIL — `componentField` not exported; dynamicZone variant unknown.

- [ ] **Step 3: Update implementation**

In `packages/ir-schema/src/fields.ts`, add the structural variants and the two unions.
Replace the previous `export const field = ...` line with the block below and add the variants
above it:
```ts
const relationField = z.object({
  type: z.literal("relation"), ...common,
  relationKind: z.enum(RELATION_KINDS),
  target: typeName,
  inverse: fieldName.optional(),
});
const componentRefField = z.object({
  type: z.literal("component"), ...common,
  component: typeName,
  repeatable: z.boolean(),
});
const dynamicZoneField = z.object({
  type: z.literal("dynamicZone"), ...common,
  components: z.array(typeName).min(1),
});

const ALL_VARIANTS = [...SCALAR_VARIANTS, relationField, componentRefField, dynamicZoneField] as const;
const COMPONENT_VARIANTS = [...SCALAR_VARIANTS, relationField, componentRefField] as const; // no dynamicZone (D6)

export const field = z.discriminatedUnion("type", [...ALL_VARIANTS]).superRefine(perFieldRefine);
export const componentField = z.discriminatedUnion("type", [...COMPONENT_VARIANTS]).superRefine(perFieldRefine);

export type Field = z.infer<typeof field>;
export type ComponentFieldT = z.infer<typeof componentField>;
```
Remove the now-stale `export const field = z.discriminatedUnion("type", [...SCALAR_VARIANTS])...`
line from Task 3 (it is superseded). The `dynamicZone.components` use `z.array(typeName).min(1)`,
giving S7 (the `.min(1)` failure) and a Zod issue; map to `empty_dynamic_zone` in Task 6.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/fields.test.ts`
Expected: PASS (all scalar + structural tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ir-schema
git commit -m "feat(ir-schema): relation/component/dynamicZone variants and field unions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Document schemas + node-level refinements

**Files:**
- Create: `packages/ir-schema/src/document.ts`
- Test: `packages/ir-schema/src/document.test.ts`

Node-level `superRefine` covers S5 (duplicate field names), S8 (reserved `id`), S10
(`uid.targetField` resolves to a sibling).

- [ ] **Step 1: Write the failing test**

`packages/ir-schema/src/document.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { contentType } from "./document";

const ct = (fields: unknown[]) => contentType.safeParse({ name: "Article", kind: "collection", fields });

describe("contentType node refinements", () => {
  it("accepts a valid type", () => {
    expect(ct([{ type: "string", name: "title" }]).success).toBe(true);
  });

  it("rejects duplicate field names (S5)", () => {
    expect(ct([{ type: "string", name: "title" }, { type: "text", name: "title" }]).success).toBe(false);
  });

  it("rejects the reserved field name id (S8)", () => {
    expect(ct([{ type: "string", name: "id" }]).success).toBe(false);
  });

  it("accepts uid.targetField pointing at a sibling (S10)", () => {
    expect(ct([{ type: "string", name: "title" }, { type: "uid", name: "slug", targetField: "title" }]).success).toBe(true);
  });

  it("rejects uid.targetField with no such sibling (S10)", () => {
    expect(ct([{ type: "uid", name: "slug", targetField: "missing" }]).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/document.test.ts`
Expected: FAIL — cannot resolve `./document`.

- [ ] **Step 3: Write minimal implementation**

`packages/ir-schema/src/document.ts`
```ts
import { z } from "zod";
import { componentField, field } from "./fields";
import { typeName } from "./identifiers";

const RESERVED_FIELD_NAMES = new Set(["id"]);

const nodeRefine = (fields: { name: string; type: string; targetField?: string }[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    if (seen.has(f.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate field name "${f.name}"`, params: { irCode: "duplicate_field" }, path: ["fields", i, "name"] });
    }
    seen.add(f.name);
    if (RESERVED_FIELD_NAMES.has(f.name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${f.name}" is a reserved field name`, params: { irCode: "reserved_field_name" }, path: ["fields", i, "name"] });
    }
  });
  fields.forEach((f, i) => {
    if (f.type === "uid" && f.targetField !== undefined && !fields.some((s) => s.name === f.targetField)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `uid targetField "${f.targetField}" does not exist`, params: { irCode: "unknown_uid_target" }, path: ["fields", i, "targetField"] });
    }
  });
};

export const contentType = z
  .object({
    name: typeName,
    kind: z.enum(["collection", "single"]),
    names: z.object({ plural: z.string().optional(), display: z.string().optional(), collection: z.string().optional() }).optional(),
    fields: z.array(field),
    options: z.object({ draftPublish: z.boolean().optional(), timestamps: z.boolean().optional(), softDelete: z.boolean().optional() }).optional(),
  })
  .superRefine((ct, ctx) => nodeRefine(ct.fields, ctx));

export const component = z
  .object({ name: typeName, fields: z.array(componentField) })
  .superRefine((c, ctx) => nodeRefine(c.fields, ctx));

export const irDocument = z.object({
  version: z.literal(1),
  contentTypes: z.array(contentType),
  components: z.array(component),
});

export type ContentType = z.infer<typeof contentType>;
export type Component = z.infer<typeof component>;
export type IrDocument = z.infer<typeof irDocument>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/document.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ir-schema
git commit -m "feat(ir-schema): document schemas with node-level refinements

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: parseDocument + ZodIssue → IrError mapping

**Files:**
- Create: `packages/ir-schema/src/parse.ts`
- Test: `packages/ir-schema/src/parse.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/ir-schema/src/parse.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { parseDocument } from "./parse";

const doc = (overrides: Record<string, unknown>) => ({
  version: 1,
  contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] }],
  components: [],
  ...overrides,
});

describe("parseDocument", () => {
  it("returns ok for a valid document", () => {
    const r = parseDocument(doc({}));
    expect(r.ok).toBe(true);
  });

  it("maps a duplicate-field issue to a located IrError", () => {
    const r = parseDocument(doc({
      contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }, { type: "text", name: "title" }] }],
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const e = r.errors.find((x) => x.code === "duplicate_field");
    expect(e?.location).toMatchObject({ contentType: "Article", field: "title" });
  });

  it("maps a bad identifier to invalid_identifier", () => {
    const r = parseDocument(doc({
      contentTypes: [{ name: "article", kind: "collection", fields: [] }],
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((x) => x.code === "invalid_identifier")).toBe(true);
  });

  it("emits errors in deterministic (path) order", () => {
    const r = parseDocument(doc({
      contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "id" }, { type: "text", name: "id" }] }],
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const sorted = [...r.errors].sort((a, b) => JSON.stringify(a.path).localeCompare(JSON.stringify(b.path)));
    expect(r.errors.map((e) => e.code)).toEqual(sorted.map((e) => e.code));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/parse.test.ts`
Expected: FAIL — cannot resolve `./parse`.

- [ ] **Step 3: Write minimal implementation**

`packages/ir-schema/src/parse.ts`
```ts
import type { z } from "zod";
import { irDocument } from "./document";
import { fail, ok, type IrError, type IrErrorCode, type IrErrorLocation, type Result } from "./errors";

const codeFromIssue = (issue: z.ZodIssue): IrErrorCode => {
  const params = (issue as { params?: { irCode?: IrErrorCode } }).params;
  if (params?.irCode) return params.irCode;
  if (issue.code === "invalid_string") return "invalid_identifier";
  if (issue.code === "too_small" && issue.path.at(-1) === "values") return "empty_enumeration";
  if (issue.code === "too_small" && issue.path.at(-1) === "components") return "empty_dynamic_zone";
  return "invalid_document";
};

// Walk the input by the issue path to recover human names for the location.
const locationFromPath = (input: unknown, path: (string | number)[]): IrErrorLocation => {
  const loc: IrErrorLocation = {};
  let node: unknown = input;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    if (node === null || typeof node !== "object") break;
    node = (node as Record<string | number, unknown>)[key];
    if (Array.isArray(node)) continue;
    if (node && typeof node === "object") {
      const named = node as { name?: unknown };
      if (typeof named.name === "string") {
        if (path[i - 1] === "contentTypes") loc.contentType = named.name;
        else if (path[i - 1] === "components") loc.component = named.name;
        else if (path[i - 1] === "fields") loc.field = named.name;
      }
    }
  }
  return loc;
};

const byPath = (a: IrError, b: IrError) => JSON.stringify(a.path).localeCompare(JSON.stringify(b.path));

export const parseDocument = (input: unknown): Result<z.infer<typeof irDocument>> => {
  const r = irDocument.safeParse(input);
  if (r.success) return ok(r.data);
  const errors: IrError[] = r.error.issues
    .map((issue) => ({
      code: codeFromIssue(issue),
      message: issue.message,
      location: locationFromPath(input, issue.path),
      path: [...issue.path],
    }))
    .sort(byPath);
  return fail(errors);
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/parse.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ir-schema
git commit -m "feat(ir-schema): parseDocument with located error mapping

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Capability types + public surface

**Files:**
- Create: `packages/ir-schema/src/capability.ts`
- Create: `packages/ir-schema/src/index.ts`
- Test: `packages/ir-schema/src/capability.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/ir-schema/src/capability.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { CapabilityDescriptor, CapabilityGapReport } from "./index";

describe("capability types", () => {
  it("a descriptor value is well-typed and usable", () => {
    const d: CapabilityDescriptor = {
      target: "strapi",
      fieldTypes: { string: true, dynamicZone: true },
      relationKinds: { manyToMany: true },
      features: { component: true },
    };
    const report: CapabilityGapReport = { target: "strapi", gaps: [] };
    expect(d.target).toBe("strapi");
    expect(report.gaps).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/capability.test.ts`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Write implementation**

`packages/ir-schema/src/capability.ts`
```ts
import type { FieldType, RelationKind } from "./fields";
import type { IrErrorLocation } from "./errors";

export interface CapabilityDescriptor {
  target: string;
  fieldTypes: Partial<Record<FieldType, boolean>>;
  relationKinds: Partial<Record<RelationKind, boolean>>;
  features: Partial<Record<"dynamicZone" | "component" | "softDelete" | "draftPublish" | "media", boolean>>;
}

export interface CapabilityGap {
  feature: string;
  location: IrErrorLocation;
  severity: "error" | "downgrade";
  message: string;
}

export interface CapabilityGapReport {
  target: string;
  gaps: CapabilityGap[];
}
```

`packages/ir-schema/src/index.ts`
```ts
export { fail, ok } from "./errors";
export type { IrError, IrErrorCode, IrErrorLocation, Result } from "./errors";
export { FIELD_TYPES, RELATION_KINDS, componentField, field } from "./fields";
export type { ComponentFieldT, Field, FieldType, RelationKind } from "./fields";
export { component, contentType, irDocument } from "./document";
export type { Component, ContentType, IrDocument } from "./document";
export { parseDocument } from "./parse";
export type { CapabilityDescriptor, CapabilityGap, CapabilityGapReport } from "./capability";
```

Replace `packages/ir-schema/src/index.ts`'s prior stub contents entirely with the above.

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm --filter @camis/ir-schema exec vitest run src/capability.test.ts`
Run: `pnpm --filter @camis/ir-schema typecheck`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/ir-schema
git commit -m "feat(ir-schema): capability types and public surface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: ir-core inflection helpers

**Files:**
- Create: `packages/ir-core/src/inflect.ts`
- Test: `packages/ir-core/src/inflect.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/ir-core/src/inflect.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { humanize, pluralize, snakeCase } from "./inflect";

describe("inflect", () => {
  it("humanize splits PascalCase", () => {
    expect(humanize("BlogPost")).toBe("Blog Post");
    expect(humanize("Article")).toBe("Article");
  });

  it("snakeCase pluralizes and lowercases", () => {
    expect(snakeCase("BlogPost")).toBe("blog_post");
  });

  it("pluralize applies s/es/ies rules", () => {
    expect(pluralize("Article")).toBe("Articles");
    expect(pluralize("Box")).toBe("Boxes");
    expect(pluralize("Category")).toBe("Categories");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @camis/ir-core exec vitest run src/inflect.test.ts`
Expected: FAIL — cannot resolve `./inflect`.

- [ ] **Step 3: Write minimal implementation**

`packages/ir-core/src/inflect.ts`
```ts
const words = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ");

export const humanize = (name: string): string => words(name).join(" ");

export const snakeCase = (name: string): string => words(name).map((w) => w.toLowerCase()).join("_");

export const pluralize = (word: string): string => {
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, "ies");
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @camis/ir-core exec vitest run src/inflect.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ir-core
git commit -m "feat(ir-core): deterministic inflection helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: ir-core normalize

**Files:**
- Modify: `packages/ir-core/package.json` (add `@camis/ir-schema` workspace dep)
- Create: `packages/ir-core/src/normalize.ts`
- Test: `packages/ir-core/src/normalize.test.ts`

- [ ] **Step 1: Add the workspace dependency**

Run: `pnpm --filter @camis/ir-core add @camis/ir-schema@workspace:*`

- [ ] **Step 2: Write the failing test**

`packages/ir-core/src/normalize.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { normalize } from "./normalize";

const base: IrDocument = {
  version: 1,
  contentTypes: [{ name: "BlogPost", kind: "collection", fields: [{ type: "string", name: "title" }] }],
  components: [],
};

describe("normalize", () => {
  it("derives names when absent", () => {
    const ct = normalize(base).contentTypes[0]!;
    expect(ct.names).toMatchObject({ display: "Blog Post", plural: "BlogPosts", collection: "blog_posts" });
  });

  it("keeps explicit name overrides", () => {
    const doc: IrDocument = { ...base, contentTypes: [{ ...base.contentTypes[0]!, names: { collection: "posts" } }] };
    expect(normalize(doc).contentTypes[0]!.names!.collection).toBe("posts");
  });

  it("fills option defaults", () => {
    expect(normalize(base).contentTypes[0]!.options).toEqual({ draftPublish: false, timestamps: true, softDelete: false });
  });

  it("preserves field order", () => {
    const doc: IrDocument = { ...base, contentTypes: [{ name: "X", kind: "collection", fields: [{ type: "string", name: "b" }, { type: "string", name: "a" }] }] };
    expect(normalize(doc).contentTypes[0]!.fields.map((f) => f.name)).toEqual(["b", "a"]);
  });

  it("is idempotent", () => {
    const once = normalize(base);
    expect(normalize(once)).toEqual(once);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @camis/ir-core exec vitest run src/normalize.test.ts`
Expected: FAIL — cannot resolve `./normalize`.

- [ ] **Step 4: Write minimal implementation**

`packages/ir-core/src/normalize.ts`
```ts
import type { ContentType, IrDocument } from "@camis/ir-schema";
import { humanize, pluralize, snakeCase } from "./inflect";

const DEFAULT_OPTIONS = { draftPublish: false, timestamps: true, softDelete: false };

const normalizeContentType = (ct: ContentType): ContentType => ({
  ...ct,
  names: {
    display: ct.names?.display ?? humanize(ct.name),
    plural: ct.names?.plural ?? pluralize(ct.name),
    collection: ct.names?.collection ?? snakeCase(pluralize(ct.name)),
  },
  options: { ...DEFAULT_OPTIONS, ...ct.options },
});

export const normalize = (doc: IrDocument): IrDocument => ({
  ...doc,
  contentTypes: doc.contentTypes.map(normalizeContentType),
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @camis/ir-core exec vitest run src/normalize.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/ir-core
git commit -m "feat(ir-core): normalize with derived names and option defaults

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: ir-core invariants — references (C1, C2)

**Files:**
- Create: `packages/ir-core/src/invariants.ts`
- Test: `packages/ir-core/src/invariants.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/ir-core/src/invariants.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { validateInvariants } from "./invariants";

const codes = (doc: IrDocument) => validateInvariants(doc).map((e) => e.code);

describe("reference invariants", () => {
  it("flags an unknown relation target (C1)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "relation", name: "author", relationKind: "manyToOne", target: "Ghost" }] }],
      components: [],
    };
    expect(codes(doc)).toContain("unknown_relation_target");
  });

  it("allows a self relation", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [{ name: "Category", kind: "collection", fields: [{ type: "relation", name: "parent", relationKind: "manyToOne", target: "Category" }] }],
      components: [],
    };
    expect(codes(doc)).not.toContain("unknown_relation_target");
  });

  it("flags an unknown component reference (C2)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [{ name: "Page", kind: "collection", fields: [{ type: "component", name: "seo", component: "Ghost", repeatable: false }] }],
      components: [],
    };
    expect(codes(doc)).toContain("unknown_component_ref");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @camis/ir-core exec vitest run src/invariants.test.ts`
Expected: FAIL — cannot resolve `./invariants`.

- [ ] **Step 3: Write minimal implementation**

`packages/ir-core/src/invariants.ts`
```ts
import type { Component, ContentType, IrDocument, IrError } from "@camis/ir-schema";

const componentRefs = (fields: (ContentType | Component)["fields"]): { name: string; type: string; component?: string; components?: string[] }[] =>
  fields as never;

export const validateInvariants = (doc: IrDocument): IrError[] => {
  const errors: IrError[] = [];
  const typeNames = new Set(doc.contentTypes.map((t) => t.name));
  const componentNames = new Set(doc.components.map((c) => c.name));

  const checkFields = (fields: ContentType["fields"], location: IrError["location"]) => {
    for (const f of fields) {
      if (f.type === "relation" && !typeNames.has(f.target)) {
        errors.push({ code: "unknown_relation_target", message: `relation target "${f.target}" does not exist`, location: { ...location, field: f.name }, path: [] });
      }
      if (f.type === "component" && !componentNames.has(f.component)) {
        errors.push({ code: "unknown_component_ref", message: `component "${f.component}" does not exist`, location: { ...location, field: f.name }, path: [] });
      }
      if (f.type === "dynamicZone") {
        for (const c of f.components) {
          if (!componentNames.has(c)) {
            errors.push({ code: "unknown_component_ref", message: `component "${c}" does not exist`, location: { ...location, field: f.name }, path: [] });
          }
        }
      }
    }
  };

  for (const ct of doc.contentTypes) checkFields(ct.fields, { contentType: ct.name });
  for (const c of doc.components) checkFields(c.fields as ContentType["fields"], { component: c.name });
  void componentRefs;
  return errors;
};
```

*Note:* `componentRefs` is a temporary helper kept minimal; it is removed in Task 11 when the
acyclic check is added. (If lint flags it as unused, delete the `void componentRefs;` line and
the helper now.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @camis/ir-core exec vitest run src/invariants.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ir-core
git commit -m "feat(ir-core): reference-resolution invariants

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: ir-core invariants — uniqueness, acyclic, inverse collision (C3, C4, C5)

**Files:**
- Modify: `packages/ir-core/src/invariants.ts`
- Test: `packages/ir-core/src/invariants.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

Append to `packages/ir-core/src/invariants.test.ts`:
```ts
describe("uniqueness, acyclic, inverse collision", () => {
  it("flags duplicate content type names (C3)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        { name: "Article", kind: "collection", fields: [] },
        { name: "Article", kind: "single", fields: [] },
      ],
      components: [],
    };
    expect(codes(doc)).toContain("duplicate_content_type_name");
  });

  it("flags a cyclic component reference (C4)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [],
      components: [
        { name: "A", fields: [{ type: "component", name: "b", component: "B", repeatable: false }] },
        { name: "B", fields: [{ type: "component", name: "a", component: "A", repeatable: false }] },
      ],
    };
    expect(codes(doc)).toContain("cyclic_component_reference");
  });

  it("flags an inverse field that collides on the target (C5)", () => {
    const doc: IrDocument = {
      version: 1,
      contentTypes: [
        { name: "Article", kind: "collection", fields: [{ type: "relation", name: "author", relationKind: "manyToOne", target: "User", inverse: "name" }] },
        { name: "User", kind: "collection", fields: [{ type: "string", name: "name" }] },
      ],
      components: [],
    };
    expect(codes(doc)).toContain("inverse_field_collision");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @camis/ir-core exec vitest run src/invariants.test.ts`
Expected: FAIL — new codes not produced.

- [ ] **Step 3: Update implementation**

Replace the body of `validateInvariants` in `packages/ir-core/src/invariants.ts` so it adds the
three checks. Remove the temporary `componentRefs` helper and the `void componentRefs;` line.
Full file:
```ts
import type { Component, ContentType, IrDocument, IrError } from "@camis/ir-schema";

const findDuplicates = (names: string[]): string[] => {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) dupes.add(n);
    seen.add(n);
  }
  return [...dupes];
};

const componentEdges = (components: Component[]): Map<string, string[]> => {
  const edges = new Map<string, string[]>();
  for (const c of components) {
    edges.set(
      c.name,
      c.fields.flatMap((f) => (f.type === "component" ? [f.component] : [])),
    );
  }
  return edges;
};

const hasCycle = (edges: Map<string, string[]>): boolean => {
  const state = new Map<string, 0 | 1 | 2>(); // 0=unseen 1=in-stack 2=done
  const visit = (node: string): boolean => {
    if (state.get(node) === 1) return true;
    if (state.get(node) === 2) return false;
    state.set(node, 1);
    for (const next of edges.get(node) ?? []) if (visit(next)) return true;
    state.set(node, 2);
    return false;
  };
  return [...edges.keys()].some(visit);
};

export const validateInvariants = (doc: IrDocument): IrError[] => {
  const errors: IrError[] = [];
  const typeByName = new Map(doc.contentTypes.map((t) => [t.name, t] as const));
  const componentNames = new Set(doc.components.map((c) => c.name));

  const checkFields = (fields: ContentType["fields"], location: IrError["location"]) => {
    for (const f of fields) {
      if (f.type === "relation") {
        if (!typeByName.has(f.target)) {
          errors.push({ code: "unknown_relation_target", message: `relation target "${f.target}" does not exist`, location: { ...location, field: f.name }, path: [] });
        } else if (f.inverse !== undefined && typeByName.get(f.target)!.fields.some((tf) => tf.name === f.inverse)) {
          errors.push({ code: "inverse_field_collision", message: `inverse field "${f.inverse}" already exists on "${f.target}"`, location: { ...location, field: f.name }, path: [] });
        }
      }
      if (f.type === "component" && !componentNames.has(f.component)) {
        errors.push({ code: "unknown_component_ref", message: `component "${f.component}" does not exist`, location: { ...location, field: f.name }, path: [] });
      }
      if (f.type === "dynamicZone") {
        for (const c of f.components) {
          if (!componentNames.has(c)) {
            errors.push({ code: "unknown_component_ref", message: `component "${c}" does not exist`, location: { ...location, field: f.name }, path: [] });
          }
        }
      }
    }
  };

  for (const ct of doc.contentTypes) checkFields(ct.fields, { contentType: ct.name });
  for (const c of doc.components) checkFields(c.fields as ContentType["fields"], { component: c.name });

  for (const name of findDuplicates(doc.contentTypes.map((t) => t.name))) {
    errors.push({ code: "duplicate_content_type_name", message: `duplicate content type "${name}"`, location: { contentType: name }, path: [] });
  }
  for (const name of findDuplicates(doc.components.map((c) => c.name))) {
    errors.push({ code: "duplicate_component_name", message: `duplicate component "${name}"`, location: { component: name }, path: [] });
  }
  if (hasCycle(componentEdges(doc.components))) {
    errors.push({ code: "cyclic_component_reference", message: "component references form a cycle", location: { rule: "acyclic_components" }, path: [] });
  }
  return errors;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @camis/ir-core exec vitest run src/invariants.test.ts`
Expected: PASS (all reference + uniqueness/acyclic/inverse tests).

- [ ] **Step 5: Commit**

```bash
git add packages/ir-core
git commit -m "feat(ir-core): uniqueness, acyclic, and inverse-collision invariants

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: validate orchestration + valid fixture (exit criterion) + public surface

**Files:**
- Create: `packages/ir-core/src/__fixtures__/valid-blog.ts`
- Create: `packages/ir-core/src/validate.ts`
- Create: `packages/ir-core/src/index.ts`
- Test: `packages/ir-core/src/validate.test.ts`

- [ ] **Step 1: Write the valid multi-type fixture**

`packages/ir-core/src/__fixtures__/valid-blog.ts`
```ts
import type { IrDocument } from "@camis/ir-schema";

// Exit-criteria fixture: multiple types, a relation (incl. self-relation), and a component.
export const validBlog: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "string", name: "title", required: true },
        { type: "uid", name: "slug", targetField: "title" },
        { type: "relation", name: "author", relationKind: "manyToOne", target: "User", inverse: "articles" },
        { type: "component", name: "seo", component: "SeoMeta", repeatable: false },
      ],
    },
    { name: "User", kind: "collection", fields: [{ type: "string", name: "email" }] },
    { name: "Category", kind: "collection", fields: [{ type: "relation", name: "parent", relationKind: "manyToOne", target: "Category" }] },
  ],
  components: [{ name: "SeoMeta", fields: [{ type: "string", name: "metaTitle" }] }],
};
```

- [ ] **Step 2: Write the failing test**

`packages/ir-core/src/validate.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { validate } from "./validate";
import { validBlog } from "./__fixtures__/valid-blog";

describe("validate", () => {
  it("accepts the valid multi-type document and returns it normalized", () => {
    const r = validate(validBlog);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.contentTypes[0]!.names!.collection).toBe("articles");
  });

  it("collects structural and cross-graph errors together", () => {
    const r = validate({
      version: 1,
      contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "relation", name: "author", relationKind: "manyToOne", target: "Ghost" }] }],
      components: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.some((e) => e.code === "unknown_relation_target")).toBe(true);
  });

  it("does not run invariants when structural parsing fails", () => {
    const r = validate({ version: 1, contentTypes: [{ name: "article", kind: "collection", fields: [] }], components: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.every((e) => e.code === "invalid_identifier")).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @camis/ir-core exec vitest run src/validate.test.ts`
Expected: FAIL — cannot resolve `./validate`.

- [ ] **Step 4: Write implementation**

`packages/ir-core/src/validate.ts`
```ts
import { fail, ok, parseDocument, type IrDocument, type Result } from "@camis/ir-schema";
import { normalize } from "./normalize";
import { validateInvariants } from "./invariants";

export const validate = (input: unknown): Result<IrDocument> => {
  const parsed = parseDocument(input);
  if (!parsed.ok) return parsed;
  const normalized = normalize(parsed.value);
  const invariantErrors = validateInvariants(normalized);
  return invariantErrors.length > 0 ? fail(invariantErrors) : ok(normalized);
};
```

`packages/ir-core/src/index.ts`
```ts
export { normalize } from "./normalize";
export { validateInvariants } from "./invariants";
export { validate } from "./validate";
export { humanize, pluralize, snakeCase } from "./inflect";
```
Replace the prior `index.ts` stub contents entirely with the above.

- [ ] **Step 5: Run test + typecheck**

Run: `pnpm --filter @camis/ir-core exec vitest run src/validate.test.ts`
Run: `pnpm --filter @camis/ir-core typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/ir-core
git commit -m "feat(ir-core): validate orchestration and valid fixture

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: ESLint boundaries + full verification

**Files:**
- Modify: `package.json` (add `eslint-plugin-boundaries`)
- Modify: `eslint.config.js`

Activates the first cross-package import guard (CLAUDE.md decision: add boundary rules at the
first real cross-package import — Task 9 introduced `ir-core → ir-schema`).

- [ ] **Step 1: Add the plugin**

Run: `pnpm add -w -D eslint-plugin-boundaries`

- [ ] **Step 2: Configure boundaries**

In `eslint.config.js`, add the import and a config block. Add at the top:
```js
import boundaries from "eslint-plugin-boundaries";
```
Add this object to the exported `tseslint.config(...)` array (after the existing rules block):
```js
{
  files: ["packages/*/src/**/*.ts"],
  plugins: { boundaries },
  settings: {
    "boundaries/elements": [
      { type: "ir-schema", pattern: "packages/ir-schema" },
      { type: "ir-core", pattern: "packages/ir-core" },
      { type: "expr", pattern: "packages/expr*" },
      { type: "permissions", pattern: "packages/permissions" },
      { type: "adapter-kernel", pattern: "packages/adapter-kernel" },
      { type: "adapter", pattern: "packages/adapter-{strapi,filament,express}" },
      { type: "ai", pattern: "packages/ai-*" },
      { type: "cli", pattern: "packages/cli" },
    ],
  },
  rules: {
    "boundaries/element-types": ["error", {
      default: "allow",
      rules: [
        { from: "ir-schema", disallow: ["ir-core", "expr", "permissions", "adapter-kernel", "adapter", "ai", "cli"], message: "ir-schema is a leaf; it must not import other packages" },
        { from: "adapter", disallow: ["adapter"], message: "adapters must not import sibling adapters" },
      ],
    }],
  },
},
```

- [ ] **Step 3: Verify the guard catches a violation**

Temporarily add to `packages/ir-schema/src/index.ts`:
```ts
import { normalize } from "@camis/ir-core"; // illegal: ir-schema must not import ir-core
void normalize;
```
Run: `pnpm lint`
Expected: FAIL with the "ir-schema is a leaf" message. Then **remove** those two lines.

- [ ] **Step 4: Full green sweep**

Run, expecting all PASS / no errors:
```bash
pnpm lint
pnpm -r typecheck
pnpm -r test
```

- [ ] **Step 5: Commit**

```bash
git add package.json eslint.config.js pnpm-lock.yaml
git commit -m "chore: enforce package boundaries via eslint-plugin-boundaries

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** D1 Zod-source (Tasks 3–7) · D2 no JSON Schema (omitted, correct) · D3 names + overrides (Task 9) · D4 unified error (Task 1, mapping Task 6) · D5 relations-in-components (Task 4 `componentField` includes relation) · D6 DZ-only via union (Task 4) · D7 Result (Task 1, used throughout) · D8 hand-rolled inflection (Task 8) · D9 single-declaration relations + inverse collision (Tasks 4, 11) · D10 node-local vs cross-graph split (ir-schema Tasks 3–6 vs ir-core Tasks 10–11) · D11 typed codes (Task 1). Rules S1–S10 (Tasks 2,3,4,5) and C1–C5 (Tasks 10,11) each have ≥1 test. Capability types (Task 7). Valid multi-type fixture (Task 12). Exit criteria verified (Task 13).

**Placeholder scan:** none — every step has concrete code/commands. The temporary `componentRefs` helper in Task 10 is explicitly removed in Task 11.

**Type consistency:** `IrError`/`IrErrorCode`/`Result`/`IrErrorLocation` (Task 1) used unchanged everywhere; `field`/`componentField`/`parseDocument`/`IrDocument` exported (Task 7) and consumed by ir-core (Tasks 9–12); `normalize`/`validateInvariants`/`validate` signatures consistent across Tasks 9–12.
