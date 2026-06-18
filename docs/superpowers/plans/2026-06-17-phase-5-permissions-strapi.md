# Phase 5 — Permissions Model + Strapi Admin RBAC Emission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the neutral superset permission model (`@camis/permissions`) and down-project it to Strapi v5 admin RBAC, compiling Ring-1 condition predicates to TypeScript handlers, with the capability-gap report wired in.

**Architecture:** A new `permissions` package owns Role/Grant/FieldRule Zod schemas + `IrBundle` + `validateBundle` (deps: `expr`, `ir-schema`). Generation input becomes `IrBundle = { document, roles }`. The Strapi adapter gains a `permissions/` module that emits `src/permissions/roles.json` (declarative seed data) and `src/permissions/conditions.ts` (a self-contained module embedding the Ring-1 TS runtime + fail-closed condition handlers), and extends the bootstrap to register conditions and seed roles. `expr` gains `freeVars`; `expr-ts` gains `tsRuntimeSource()`.

**Tech Stack:** TypeScript (strict, ESM, Bundler resolution), Zod v3, Vitest (golden snapshots via `toMatchFileSnapshot`), `@camis/adapter-kernel` (`stableJson`, `sha256`).

**Design spec:** `docs/superpowers/specs/2026-06-17-phase-5-permissions-strapi-design.md`

---

## File structure

**`packages/expr/`** — `src/free-vars.ts` (new), `src/free-vars.test.ts` (new), `src/index.ts` (export).
**`packages/expr-ts/`** — `src/runtime-source.ts` (new), `src/runtime-source.test.ts` (new), `src/index.ts` (export).
**`packages/ir-schema/`** — `src/errors.ts` (2 new error codes), `src/index.ts` (export `typeName`, `fieldName`).
**`packages/permissions/`** — `src/actions.ts`, `src/model.ts`, `src/validate.ts`, `src/index.ts` (replace stub) + tests.
**`packages/adapter-kernel/`** — `src/types.ts` (`generate(ir: IrBundle, …)`), `package.json` (add `@camis/permissions`).
**`packages/adapter-strapi/`** — `src/permissions/actions.ts`, `src/permissions/condition-name.ts`, `src/permissions/project.ts`, `src/permissions/conditions.ts` (emitter), `src/permissions/emit.ts` (assembles files), `src/generate.ts` (wire in), `src/skeleton/templates.ts` (bootstrap), `src/__fixtures__/permissions.ts`, golden files, tests, `package.json` (add deps).
**`eslint.config.js`** — boundary allowances.

---

## Task 1: `expr` — `freeVars`

**Files:** Create `packages/expr/src/free-vars.ts`, `packages/expr/src/free-vars.test.ts`; Modify `packages/expr/src/index.ts`

- [ ] **Step 1: Failing test** — `packages/expr/src/free-vars.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { freeVars } from "./free-vars";
import type { Expression } from "./ast";

describe("freeVars", () => {
  it("returns distinct var names, sorted", () => {
    const e: Expression = {
      kind: "and",
      args: [
        { kind: "eq", left: { kind: "var", name: "user.role" }, right: { kind: "lit", value: "editor" } },
        { kind: "not", arg: { kind: "var", name: "user.active" } },
        { kind: "var", name: "user.role" },
      ],
    };
    expect(freeVars(e)).toEqual(["user.active", "user.role"]);
  });
  it("is empty for a literal-only expression", () => {
    expect(freeVars({ kind: "lit", value: 1 })).toEqual([]);
  });
  it("walks call and arithmetic operands", () => {
    const e: Expression = {
      kind: "call",
      fn: "coalesce",
      args: [{ kind: "add", left: { kind: "var", name: "a" }, right: { kind: "var", name: "b" } }],
    };
    expect(freeVars(e)).toEqual(["a", "b"]);
  });
});
```

- [ ] **Step 2: Run — FAIL** — `pnpm --filter @camis/expr exec vitest run src/free-vars.test.ts` (Expected: cannot find `./free-vars`).

- [ ] **Step 3: Implement** — `packages/expr/src/free-vars.ts`
```ts
import type { Expression } from "./ast";

/** Distinct variable names referenced by an expression (sorted). Pure AST walk. */
export const freeVars = (expr: Expression): string[] => {
  const acc = new Set<string>();
  const walk = (e: Expression): void => {
    switch (e.kind) {
      case "lit":
        return;
      case "var":
        acc.add(e.name);
        return;
      case "not":
        walk(e.arg);
        return;
      case "and":
      case "or":
      case "call":
        e.args.forEach(walk);
        return;
      default:
        walk(e.left);
        walk(e.right);
    }
  };
  walk(expr);
  return [...acc].sort();
};
```

- [ ] **Step 4: Export** — append to `packages/expr/src/index.ts`:
```ts
export { freeVars } from "./free-vars";
```

- [ ] **Step 5: Run — PASS** — `pnpm --filter @camis/expr exec vitest run src/free-vars.test.ts`; then `pnpm --filter @camis/expr typecheck`.

- [ ] **Step 6: Commit**
```bash
git add packages/expr
git commit -m "feat(expr): freeVars — distinct variable names in an expression

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `expr-ts` — `tsRuntimeSource` (embeddable runtime)

The generated standalone project cannot `import "@camis/expr"`. `tsRuntimeSource()` returns a self-contained module: a fixed preamble inlining `Value`/`EvalResult`/`EvalError`/`ok`/`err`, followed by the body of `runtime.ts` with its `@camis/expr` import line stripped. The operator semantics come verbatim from the conformance-tested `runtime.ts`, so behavior cannot drift; the inlined preamble only re-declares the trivial value/error helpers.

**Files:** Create `packages/expr-ts/src/runtime-source.ts`, `packages/expr-ts/src/runtime-source.test.ts`; Modify `packages/expr-ts/src/index.ts`

- [ ] **Step 1: Failing test** — `packages/expr-ts/src/runtime-source.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { tsRuntimeSource } from "./runtime-source";

describe("tsRuntimeSource", () => {
  it("is self-contained: no @camis/expr import, exports r", () => {
    const src = tsRuntimeSource();
    expect(src).not.toContain("@camis/expr");
    expect(src).toContain("export const r");
    expect(src).toContain("const ok = (value: Value)");
  });
  it("is stable across calls", () => {
    expect(tsRuntimeSource()).toBe(tsRuntimeSource());
  });
});
```

- [ ] **Step 2: Run — FAIL** — `pnpm --filter @camis/expr-ts exec vitest run src/runtime-source.test.ts`.

- [ ] **Step 3: Implement** — `packages/expr-ts/src/runtime-source.ts`
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PREAMBLE = `type Value = null | boolean | number | string;
type EvalError = "TYPE_MISMATCH" | "DIV_BY_ZERO" | "UNKNOWN_VAR";
type EvalResult = { ok: true; value: Value } | { ok: false; error: EvalError };
const ok = (value: Value): EvalResult => ({ ok: true, value });
const err = (error: EvalError): EvalResult => ({ ok: false, error });
`;

const runtimePath = fileURLToPath(new URL("./runtime.ts", import.meta.url));

/**
 * The Ring-1 TS runtime as a self-contained, embeddable module for generated projects.
 * Strips the `@camis/expr` import (those names are inlined by PREAMBLE); the operator
 * body is copied verbatim from the conformance-tested runtime, so semantics cannot drift.
 */
export const tsRuntimeSource = (): string => {
  const body = readFileSync(runtimePath, "utf8").replace(/^import\s.*from\s+"@camis\/expr";\n/m, "");
  return PREAMBLE + body;
};
```

- [ ] **Step 4: Export** — append to `packages/expr-ts/src/index.ts`:
```ts
export { tsRuntimeSource } from "./runtime-source";
```

- [ ] **Step 5: Run — PASS** — `pnpm --filter @camis/expr-ts exec vitest run src/runtime-source.test.ts`; then `pnpm --filter @camis/expr-ts typecheck`.

- [ ] **Step 6: Commit**
```bash
git add packages/expr-ts
git commit -m "feat(expr-ts): tsRuntimeSource — embeddable Ring-1 runtime for generated projects

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `permissions` — model schemas

**Files:** Create `packages/permissions/src/actions.ts`, `packages/permissions/src/model.ts`, `packages/permissions/src/model.test.ts`; Modify `packages/permissions/package.json` (add deps), `packages/ir-schema/src/index.ts` (export identifiers)

- [ ] **Step 1: Add deps** — Run: `pnpm --filter @camis/permissions add @camis/expr@workspace:* @camis/ir-schema@workspace:*`

- [ ] **Step 2: Export identifiers from ir-schema** — append to `packages/ir-schema/src/index.ts`:
```ts
export { fieldName, typeName } from "./identifiers";
```

- [ ] **Step 3: Failing test** — `packages/permissions/src/model.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { role } from "./model";

describe("role schema", () => {
  it("accepts a role with a field rule and a condition", () => {
    const r = role.safeParse({
      name: "Editor",
      grants: [{
        contentType: "Article",
        actions: ["read", "update"],
        fieldRules: [{ field: "secret", access: "read", when: { kind: "var", name: "user.role" } }],
        condition: { kind: "eq", left: { kind: "var", name: "user.role" }, right: { kind: "lit", value: "editor" } },
      }],
    });
    expect(r.success).toBe(true);
  });
  it("rejects a grant with no actions", () => {
    const r = role.safeParse({ name: "X", grants: [{ contentType: "Article", actions: [] }] });
    expect(r.success).toBe(false);
  });
  it("rejects a condition that is not a valid expression", () => {
    const r = role.safeParse({
      name: "X",
      grants: [{ contentType: "Article", actions: ["read"], condition: { kind: "loop" } }],
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 4: Run — FAIL** — `pnpm --filter @camis/permissions exec vitest run src/model.test.ts`.

- [ ] **Step 5: Implement actions** — `packages/permissions/src/actions.ts`
```ts
import { z } from "zod";

export const ACTIONS = ["create", "read", "update", "delete", "publish"] as const;
export type Action = (typeof ACTIONS)[number];
export const action = z.enum(ACTIONS);
```

- [ ] **Step 6: Implement model** — `packages/permissions/src/model.ts`
```ts
import { z } from "zod";
import { expression } from "@camis/expr";
import { fieldName, typeName } from "@camis/ir-schema";
import { action } from "./actions";

export const fieldRule = z.object({
  field: fieldName,
  access: z.enum(["read", "write"]),
  when: expression.optional(),
});
export type FieldRule = z.infer<typeof fieldRule>;

export const grant = z.object({
  contentType: typeName,
  actions: z.array(action).min(1),
  fieldRules: z.array(fieldRule).optional(),
  condition: expression.optional(),
});
export type Grant = z.infer<typeof grant>;

export const role = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  grants: z.array(grant),
});
export type Role = z.infer<typeof role>;
```

- [ ] **Step 7: Run — PASS** — `pnpm --filter @camis/permissions exec vitest run src/model.test.ts`; then `pnpm --filter @camis/permissions typecheck`.

- [ ] **Step 8: Commit**
```bash
git add packages/permissions packages/ir-schema/src/index.ts pnpm-lock.yaml
git commit -m "feat(permissions): neutral role/grant/field-rule model

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `permissions` — `IrBundle` + `validateBundle`

`validateBundle` cross-checks references against the document. `Result`/`fail`/`ok`/`IrError` come from `@camis/ir-schema` (its `errors.ts`). Two new error codes are added to ir-schema's closed `IrErrorCode` union.

**Files:** Modify `packages/ir-schema/src/errors.ts` (2 codes); Create `packages/permissions/src/validate.ts`, `packages/permissions/src/validate.test.ts`, `packages/permissions/src/index.ts` (replace stub)

- [ ] **Step 1: Add error codes** — in `packages/ir-schema/src/errors.ts`, add to the `IrErrorCode` union:
```ts
  | "unknown_grant_content_type"
  | "unknown_field_rule_field"
```

- [ ] **Step 2: Failing test** — `packages/permissions/src/validate.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { validateBundle } from "./validate";

const doc: IrDocument = {
  version: 1,
  contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] }],
  components: [],
};

describe("validateBundle", () => {
  it("accepts grants and field rules that reference existing targets", () => {
    const r = validateBundle({
      document: doc,
      roles: [{ name: "Ed", grants: [{ contentType: "Article", actions: ["read"], fieldRules: [{ field: "title", access: "read" }] }] }],
    });
    expect(r.ok).toBe(true);
  });
  it("rejects a grant on an unknown content type", () => {
    const r = validateBundle({ document: doc, roles: [{ name: "Ed", grants: [{ contentType: "Ghost", actions: ["read"] }] }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("unknown_grant_content_type");
  });
  it("rejects a field rule on an unknown field", () => {
    const r = validateBundle({
      document: doc,
      roles: [{ name: "Ed", grants: [{ contentType: "Article", actions: ["read"], fieldRules: [{ field: "ghost", access: "read" }] }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe("unknown_field_rule_field");
  });
});
```

- [ ] **Step 3: Run — FAIL** — `pnpm --filter @camis/permissions exec vitest run src/validate.test.ts`.

- [ ] **Step 4: Implement** — `packages/permissions/src/validate.ts`
```ts
import { fail, ok, type IrDocument, type IrError, type Result } from "@camis/ir-schema";
import type { Role } from "./model";

export interface IrBundle {
  document: IrDocument;
  roles: Role[];
}

/** Cross-check that every grant/field-rule references an existing content type and field. */
export const validateBundle = (bundle: IrBundle): Result<IrBundle> => {
  const byName = new Map(bundle.document.contentTypes.map((ct) => [ct.name, ct]));
  const errors: IrError[] = [];
  bundle.roles.forEach((role, ri) => {
    role.grants.forEach((grant, gi) => {
      const ct = byName.get(grant.contentType);
      if (!ct) {
        errors.push({
          code: "unknown_grant_content_type",
          message: `grant references unknown content type "${grant.contentType}"`,
          location: { contentType: grant.contentType, rule: role.name },
          path: ["roles", ri, "grants", gi, "contentType"],
        });
        return;
      }
      const fields = new Set(ct.fields.map((f) => f.name));
      grant.fieldRules?.forEach((fr, fi) => {
        if (!fields.has(fr.field)) {
          errors.push({
            code: "unknown_field_rule_field",
            message: `field rule references unknown field "${grant.contentType}.${fr.field}"`,
            location: { contentType: grant.contentType, field: fr.field, rule: role.name },
            path: ["roles", ri, "grants", gi, "fieldRules", fi, "field"],
          });
        }
      });
    });
  });
  return errors.length > 0 ? fail(errors) : ok(bundle);
};
```

- [ ] **Step 5: Public surface** — replace `packages/permissions/src/index.ts`:
```ts
export { ACTIONS, action } from "./actions";
export type { Action } from "./actions";
export { fieldRule, grant, role } from "./model";
export type { FieldRule, Grant, Role } from "./model";
export { validateBundle } from "./validate";
export type { IrBundle } from "./validate";
```

- [ ] **Step 6: Run — PASS** — `pnpm --filter @camis/permissions test`; then `pnpm --filter @camis/permissions typecheck` and `pnpm --filter @camis/ir-schema test` (codes added, nothing broken).

- [ ] **Step 7: Commit**
```bash
git add packages/permissions packages/ir-schema/src/errors.ts
git commit -m "feat(permissions): IrBundle + validateBundle reference checks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `adapter-kernel` — `generate(ir: IrBundle, …)` + migrate call sites

The generation contract now takes the bundle. `roles: []` emits no permission artifacts, so every existing golden stays byte-identical. This task keeps the whole tree green with a pure signature migration (no new behavior).

**Files:** Modify `packages/adapter-kernel/src/types.ts`, `packages/adapter-kernel/package.json` (add `@camis/permissions`), `packages/adapter-strapi/src/generate.ts`; and update every `strapiAdapter.generate(X, …)` call to `strapiAdapter.generate({ document: X, roles: [] }, …)` in: `packages/adapter-strapi/scripts/boot-smoke.ts`, `src/generate.test.ts`, `src/round-trip.test.ts`, `src/smoke.structural.test.ts`, `src/golden.test.ts`, `src/import/import-document.test.ts`, `src/import/read-project.test.ts`.

- [ ] **Step 1: Add kernel dep** — Run: `pnpm --filter @camis/adapter-kernel add @camis/permissions@workspace:*`

- [ ] **Step 2: Change the contract** — in `packages/adapter-kernel/src/types.ts`, replace the `IrDocument` import and the `GenerateAdapter` interface:
```ts
import type { CapabilityGapReport } from "@camis/ir-schema";
import type { IrBundle } from "@camis/permissions";
```
```ts
export interface GenerateAdapter {
  target: string;
  generate(ir: IrBundle, options: GenerateOptions): GenerationResult;
}
```
(Leave `GeneratedFile`/`Manifest`/`GenerationResult`/`GenerateOptions` unchanged. `IrDocument` is no longer referenced here.)

- [ ] **Step 3: Update strapiAdapter** — in `packages/adapter-strapi/src/generate.ts`, change the generate head to destructure the bundle (permission emission is added in Task 9; for now `roles` is unused but destructured):
```ts
  generate: (ir, options): GenerationResult => {
    const doc = normalize(ir.document);
    const inverses = synthesizedInverses(doc);
    const files: GeneratedFile[] = [
      ...skeletonFiles(options.projectName),
      ...doc.contentTypes.flatMap((ct) => typeFiles(ct, inverses.get(ct.name) ?? {})),
      ...doc.components.map(componentFile),
    ];
    return {
      files,
      manifest: buildManifest(files),
      gaps: { target: "strapi", gaps: [...softDeleteGaps(doc), ...dynamicZoneGaps(doc)] },
    };
  },
```
Remove the now-unused `type IrDocument` from the import if it is only used in the signature; keep it if `softDeleteGaps`/`dynamicZoneGaps` still annotate `IrDocument` (they do — keep the type import).

- [ ] **Step 4: Add strapi dep on permissions** — Run: `pnpm --filter @camis/adapter-strapi add @camis/permissions@workspace:*`

- [ ] **Step 5: Migrate all call sites** — in each file listed above, wrap the first argument. Examples:
  - `src/golden.test.ts`: `strapiAdapter.generate(blog, { projectName: "blog" })` → `strapiAdapter.generate({ document: blog, roles: [] }, { projectName: "blog" })` (all 6 occurrences, `blog` and `roundTrip`).
  - `src/generate.test.ts`: each `strapiAdapter.generate(doc | withSoftDelete, …)` → `{ document: doc, roles: [] }` etc.
  - `src/round-trip.test.ts:9`, `src/import/import-document.test.ts:34`, `src/import/read-project.test.ts:31`, `src/smoke.structural.test.ts:20,31`, `scripts/boot-smoke.ts:30`: same wrap.

- [ ] **Step 6: Run — green, goldens unchanged** —
```bash
pnpm --filter @camis/adapter-strapi test    # all pass; golden snapshots unchanged
pnpm --filter @camis/adapter-kernel typecheck
pnpm --filter @camis/adapter-strapi typecheck
```
Expected: identical golden output (no permission files emitted with `roles: []`).

- [ ] **Step 7: Commit**
```bash
git add packages/adapter-kernel packages/adapter-strapi pnpm-lock.yaml
git commit -m "refactor(adapter): generate takes an IrBundle { document, roles }

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Strapi action-UID map + deterministic condition name

**Files:** Create `packages/adapter-strapi/src/permissions/actions.ts`, `packages/adapter-strapi/src/permissions/condition-name.ts`, `packages/adapter-strapi/src/permissions/condition-name.test.ts`

- [ ] **Step 1: Action-UID map** — `packages/adapter-strapi/src/permissions/actions.ts`
```ts
import type { Action } from "@camis/permissions";

// The one place Strapi content-manager action UIDs live; the fact most likely to drift
// across Strapi versions, so it is isolated and golden-locked.
export const STRAPI_ACTION_UID: Record<Action, string> = {
  create: "plugin::content-manager.explorer.create",
  read: "plugin::content-manager.explorer.read",
  update: "plugin::content-manager.explorer.update",
  delete: "plugin::content-manager.explorer.delete",
  publish: "plugin::content-manager.explorer.publish",
};

// Field access maps to the content-manager actions it gates.
export const FIELD_ACCESS_ACTIONS: Record<"read" | "write", Action[]> = {
  read: ["read"],
  write: ["create", "update"],
};
```

- [ ] **Step 2: Failing test** — `packages/adapter-strapi/src/permissions/condition-name.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { conditionName } from "./condition-name";

const a: Expression = { kind: "eq", left: { kind: "var", name: "user.role" }, right: { kind: "lit", value: "editor" } };
const b: Expression = { kind: "eq", left: { kind: "var", name: "user.role" }, right: { kind: "lit", value: "admin" } };

describe("conditionName", () => {
  it("is stable and starts with the camis prefix", () => {
    expect(conditionName(a)).toBe(conditionName(a));
    expect(conditionName(a)).toMatch(/^camis-cond-[0-9a-f]{8}$/);
  });
  it("differs for different predicates", () => {
    expect(conditionName(a)).not.toBe(conditionName(b));
  });
});
```

- [ ] **Step 3: Run — FAIL** — `pnpm --filter @camis/adapter-strapi exec vitest run src/permissions/condition-name.test.ts`.

- [ ] **Step 4: Implement** — `packages/adapter-strapi/src/permissions/condition-name.ts`
```ts
import { sha256, stableJson } from "@camis/adapter-kernel";
import type { Expression } from "@camis/expr";

/** Deterministic, dedup-friendly Strapi condition name derived from the predicate. */
export const conditionName = (predicate: Expression): string =>
  `camis-cond-${sha256(stableJson(predicate)).slice(0, 8)}`;
```

- [ ] **Step 5: Run — PASS** — `pnpm --filter @camis/adapter-strapi exec vitest run src/permissions/condition-name.test.ts`; then `pnpm --filter @camis/adapter-strapi typecheck`.

- [ ] **Step 6: Commit**
```bash
git add packages/adapter-strapi/src/permissions
git commit -m "feat(adapter-strapi): action-UID map + deterministic condition names

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Strapi permission projection (roles.json data + gaps)

Projects `Role[]` → `{ roles, conditions, gaps }`. `roles` is the seed-data structure; `conditions` is the deduped predicate list (predicate + name); `gaps` flags predicates whose free vars escape the `user.*` context and `publish` on non-draftPublish types.

**Files:** Create `packages/adapter-strapi/src/permissions/project.ts`, `packages/adapter-strapi/src/permissions/project.test.ts`

- [ ] **Step 1: Failing test** — `packages/adapter-strapi/src/permissions/project.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { projectPermissions } from "./project";

const doc: IrDocument = {
  version: 1,
  contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "secret" }] }],
  components: [],
};

const editor: Role = {
  name: "Editor",
  grants: [{
    contentType: "Article",
    actions: ["read", "update"],
    fieldRules: [{ field: "secret", access: "read", when: { kind: "eq", left: { kind: "var", name: "user.role" }, right: { kind: "lit", value: "editor" } } }],
    condition: { kind: "eq", left: { kind: "var", name: "user.role" }, right: { kind: "lit", value: "editor" } },
  }],
};

describe("projectPermissions", () => {
  it("emits permission entries with subject, conditions, and field-gated entry; no gaps for user.* predicates", () => {
    const out = projectPermissions(doc, [editor]);
    expect(out.gaps).toEqual([]);
    const role = out.roles.find((r) => r.name === "Editor")!;
    // base read/update entries carry the grant condition
    const read = role.permissions.find((p) => p.action.endsWith(".read") && !p.properties)!;
    expect(read.subject).toBe("api::article.article");
    expect(read.conditions).toEqual([expect.stringMatching(/^camis-cond-/)]);
    // field rule with `when` produces a separate field-scoped entry
    const fieldEntry = role.permissions.find((p) => p.properties?.fields?.includes("secret"))!;
    expect(fieldEntry.conditions).toEqual([expect.stringMatching(/^camis-cond-/)]);
    // deduped conditions surfaced for emission
    expect(out.conditions.length).toBe(1);
  });
  it("gaps a predicate that references vars outside user.*", () => {
    const r: Role = { name: "R", grants: [{ contentType: "Article", actions: ["read"], condition: { kind: "var", name: "record.ownerId" } }] };
    const out = projectPermissions(doc, [r]);
    expect(out.gaps.map((g) => g.feature)).toContain("conditionContext");
  });
  it("gaps publish on a non-draftPublish type", () => {
    const r: Role = { name: "R", grants: [{ contentType: "Article", actions: ["publish"] }] };
    const out = projectPermissions(doc, [r]);
    expect(out.gaps.map((g) => g.feature)).toContain("publishWithoutDraft");
  });
});
```

- [ ] **Step 2: Run — FAIL** — `pnpm --filter @camis/adapter-strapi exec vitest run src/permissions/project.test.ts`.

- [ ] **Step 3: Implement** — `packages/adapter-strapi/src/permissions/project.ts`
```ts
import type { Expression } from "@camis/expr";
import { freeVars } from "@camis/expr";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { strapiNames } from "../names";
import { FIELD_ACCESS_ACTIONS, STRAPI_ACTION_UID } from "./actions";
import { conditionName } from "./condition-name";

export const USER_CONTEXT = ["user.id", "user.email", "user.role"] as const;

export interface PermissionEntry {
  action: string;
  subject: string;
  properties?: { fields: string[] };
  conditions?: string[];
}
export interface EmittedRole {
  name: string;
  description?: string;
  permissions: PermissionEntry[];
}
export interface NamedCondition {
  name: string;
  predicate: Expression;
}
export interface ProjectionResult {
  roles: EmittedRole[];
  conditions: NamedCondition[];
  gaps: CapabilityGap[];
}

const sortEntries = (a: PermissionEntry, b: PermissionEntry): number =>
  a.action === b.action ? a.subject.localeCompare(b.subject) : a.action.localeCompare(b.action);

export const projectPermissions = (doc: IrDocument, roles: Role[]): ProjectionResult => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const conditions = new Map<string, Expression>();
  const gaps: CapabilityGap[] = [];

  const register = (predicate: Expression, where: { contentType: string; field?: string; rule: string }): string => {
    const name = conditionName(predicate);
    conditions.set(name, predicate);
    const escaping = freeVars(predicate).filter((v) => !USER_CONTEXT.includes(v as (typeof USER_CONTEXT)[number]));
    if (escaping.length > 0) {
      gaps.push({
        feature: "conditionContext",
        location: { contentType: where.contentType, field: where.field, rule: where.rule },
        severity: "downgrade",
        message: `condition references ${escaping.join(", ")} outside the user.* context; it will deny at runtime`,
      });
    }
    return name;
  };

  const emittedRoles = roles.map((role): EmittedRole => {
    const permissions: PermissionEntry[] = [];
    for (const grant of role.grants) {
      const names = strapiNames(byName.get(grant.contentType)!);
      const subject = names.uid;
      const ct = byName.get(grant.contentType)!;
      const grantConditions = grant.condition ? [register(grant.condition, { contentType: grant.contentType, rule: role.name })] : undefined;

      for (const act of grant.actions) {
        if (act === "publish" && !ct.options?.draftPublish) {
          gaps.push({
            feature: "publishWithoutDraft",
            location: { contentType: grant.contentType, rule: role.name },
            severity: "downgrade",
            message: `"${grant.contentType}" has no draftPublish; publish grant is inert`,
          });
        }
        permissions.push({ action: STRAPI_ACTION_UID[act], subject, ...(grantConditions ? { conditions: grantConditions } : {}) });
      }

      for (const fr of grant.fieldRules ?? []) {
        const acts = FIELD_ACCESS_ACTIONS[fr.access];
        const condNames = fr.when ? [register(fr.when, { contentType: grant.contentType, field: fr.field, rule: role.name })] : undefined;
        for (const act of acts) {
          permissions.push({
            action: STRAPI_ACTION_UID[act],
            subject,
            properties: { fields: [fr.field] },
            ...(condNames ? { conditions: condNames } : {}),
          });
        }
      }
    }
    permissions.sort(sortEntries);
    return { name: role.name, ...(role.description ? { description: role.description } : {}), permissions };
  });

  const named = [...conditions.entries()].map(([name, predicate]): NamedCondition => ({ name, predicate })).sort((a, b) => a.name.localeCompare(b.name));
  return { roles: emittedRoles, conditions: named, gaps };
};
```

- [ ] **Step 4: Run — PASS** — `pnpm --filter @camis/adapter-strapi exec vitest run src/permissions/project.test.ts`; then `pnpm --filter @camis/adapter-strapi typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-strapi/src/permissions
git commit -m "feat(adapter-strapi): project roles to Strapi permission entries + gaps

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Strapi `conditions.ts` emitter + Ring-1 tie-in

Emits a self-contained `conditions.ts`: the embedded runtime (`tsRuntimeSource()`) + an exported `conditions` array of `{ displayName, name, plugin, handler }`, each handler building the `user.*` `data` map and returning the fail-closed boolean from the emitted predicate.

**Files:** Create `packages/adapter-strapi/src/permissions/conditions.ts`, `packages/adapter-strapi/src/permissions/conditions.test.ts`

- [ ] **Step 1: Failing test** — `packages/adapter-strapi/src/permissions/conditions.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { evaluate, r } from "@camis/expr-ts";
import { emitConditionsModule, handlerBody } from "./conditions";

const pred: Expression = { kind: "eq", left: { kind: "var", name: "user.role" }, right: { kind: "lit", value: "editor" } };

describe("conditions module", () => {
  it("is self-contained and registers each named condition", () => {
    const src = emitConditionsModule([{ name: "camis-cond-abcd1234", predicate: pred }]);
    expect(src).not.toContain("@camis/expr");
    expect(src).toContain("export const r");
    expect(src).toContain('name: "camis-cond-abcd1234"');
    expect(src).toContain('plugin: "admin"');
  });
  it("handler logic matches Ring-1 evaluate through the fail-closed mapping", () => {
    // Execute the emitted handler expression with the in-repo runtime over sample data.
    const data = { "user.role": "editor" } as Record<string, unknown>;
    const run = new Function("r", "data", "return " + handlerBody(pred)) as (rt: unknown, d: unknown) => { ok: boolean; value?: unknown };
    const result = run(r, data);
    const expected = evaluate(pred, data as never);
    expect(result).toEqual(expected);
    // fail-closed: true iff ok && value === true
    const denies = evaluate(pred, { "user.role": "viewer" } as never);
    expect(denies).toEqual({ ok: true, value: false });
  });
});
```

- [ ] **Step 2: Run — FAIL** — `pnpm --filter @camis/adapter-strapi exec vitest run src/permissions/conditions.test.ts`.

- [ ] **Step 3: Implement** — `packages/adapter-strapi/src/permissions/conditions.ts`
```ts
import type { Expression } from "@camis/expr";
import { emitTs, tsRuntimeSource } from "@camis/expr-ts";
import type { NamedCondition } from "./project";

/** The emitted Ring-1 expression for a predicate (references `r` and `data`). */
export const handlerBody = (predicate: Expression): string => emitTs(predicate);

const handler = (predicate: Expression): string =>
  `(user: { id?: unknown; email?: unknown; role?: { name?: unknown } }) => {
    const data: Record<string, Value> = {
      "user.id": (user?.id ?? null) as Value,
      "user.email": (user?.email ?? null) as Value,
      "user.role": (user?.role?.name ?? null) as Value,
    };
    const result = ${handlerBody(predicate)};
    return result.ok === true && result.value === true;
  }`;

/** A self-contained Strapi conditions module embedding the Ring-1 runtime. */
export const emitConditionsModule = (conditions: NamedCondition[]): string => {
  const entries = conditions
    .map((c) => `  {\n    displayName: ${JSON.stringify(c.name)},\n    name: ${JSON.stringify(c.name)},\n    plugin: "admin",\n    handler: ${handler(c.predicate)},\n  },`)
    .join("\n");
  return `${tsRuntimeSource()}\nexport const conditions = [\n${entries}\n];\n`;
};
```

- [ ] **Step 4: Run — PASS** — `pnpm --filter @camis/adapter-strapi exec vitest run src/permissions/conditions.test.ts`; then `pnpm --filter @camis/adapter-strapi typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-strapi/src/permissions
git commit -m "feat(adapter-strapi): emit self-contained Strapi conditions module (Ring-1 -> TS)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Assemble permission files, extend bootstrap, wire into generate + goldens

**Files:** Create `packages/adapter-strapi/src/permissions/emit.ts`, `packages/adapter-strapi/src/__fixtures__/permissions.ts`; Modify `packages/adapter-strapi/src/generate.ts`, `packages/adapter-strapi/src/skeleton/templates.ts`; Create golden test + golden files in `packages/adapter-strapi/src/__golden__/`

- [ ] **Step 1: Bootstrap template** — in `packages/adapter-strapi/src/skeleton/templates.ts`, add a permission-aware bootstrap builder (used only when roles exist; the default `SRC_INDEX_TS` stays for the no-roles case):
```ts
export const PERMISSIONS_INDEX_TS = `import { conditions } from "./permissions/conditions";
import roles from "./permissions/roles.json";

export default {
  async register() {},
  async bootstrap({ strapi }: { strapi: any }) {
    await strapi.admin.services.permission.conditionProvider.registerMany(conditions);
    for (const role of roles) {
      const existing = await strapi.query("admin::role").findOne({ where: { name: role.name } });
      const record = existing ?? (await strapi.query("admin::role").create({ data: { name: role.name, description: role.description } }));
      for (const p of role.permissions) {
        await strapi.query("admin::permission").create({ data: { ...p, role: record.id } });
      }
    }
  },
};
`;
```

- [ ] **Step 2: Emit assembler** — `packages/adapter-strapi/src/permissions/emit.ts`
```ts
import { stableJson, type GeneratedFile } from "@camis/adapter-kernel";
import type { CapabilityGap, IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { PERMISSIONS_INDEX_TS } from "../skeleton/templates";
import { emitConditionsModule } from "./conditions";
import { projectPermissions } from "./project";

export interface PermissionEmission {
  files: GeneratedFile[];
  gaps: CapabilityGap[];
  /** Replacement bootstrap when permissions are emitted (else undefined → keep skeleton default). */
  indexContent?: string;
}

export const emitPermissions = (doc: IrDocument, roles: Role[]): PermissionEmission => {
  if (roles.length === 0) return { files: [], gaps: [] };
  const { roles: emittedRoles, conditions, gaps } = projectPermissions(doc, roles);
  const files: GeneratedFile[] = [
    { path: "src/permissions/roles.json", content: stableJson(emittedRoles) },
  ];
  if (conditions.length > 0) {
    files.push({ path: "src/permissions/conditions.ts", content: emitConditionsModule(conditions) });
  }
  return { files, gaps, indexContent: PERMISSIONS_INDEX_TS };
};
```

- [ ] **Step 3: Wire into generate** — in `packages/adapter-strapi/src/generate.ts`, import `emitPermissions`, call it, append files, merge gaps, and override `src/index.ts` when permissions are emitted:
```ts
import { emitPermissions } from "./permissions/emit";
// ... inside generate, after building the base `files`:
    const perm = emitPermissions(doc, ir.roles);
    const withPerm =
      perm.indexContent === undefined
        ? files
        : files.map((f) => (f.path === "src/index.ts" ? { ...f, content: perm.indexContent! } : f));
    const allFiles = [...withPerm, ...perm.files];
    return {
      files: allFiles,
      manifest: buildManifest(allFiles),
      gaps: { target: "strapi", gaps: [...softDeleteGaps(doc), ...dynamicZoneGaps(doc), ...perm.gaps] },
    };
```
(Replace the prior `files`/`return` block accordingly.)

- [ ] **Step 4: Fixture** — `packages/adapter-strapi/src/__fixtures__/permissions.ts`
```ts
import type { IrBundle } from "@camis/permissions";

export const permissionsBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      { name: "Article", kind: "collection", options: { draftPublish: true }, fields: [
        { type: "string", name: "title" },
        { type: "string", name: "secret" },
      ] },
    ],
    components: [],
  },
  roles: [
    {
      name: "Editor",
      description: "Edits articles",
      grants: [
        {
          contentType: "Article",
          actions: ["read", "update", "publish"],
          fieldRules: [
            { field: "secret", access: "read", when: { kind: "eq", left: { kind: "var", name: "user.role" }, right: { kind: "lit", value: "editor" } } },
          ],
          condition: { kind: "eq", left: { kind: "var", name: "user.role" }, right: { kind: "lit", value: "editor" } },
        },
      ],
    },
  ],
};
```

- [ ] **Step 5: Golden + structural test** — `packages/adapter-strapi/src/permissions/golden.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { permissionsBundle } from "../__fixtures__/permissions";

describe("permissions golden", () => {
  const result = strapiAdapter.generate(permissionsBundle, { projectName: "blog" });

  it("roles.json matches the golden", async () => {
    const roles = result.files.find((f) => f.path === "src/permissions/roles.json")!.content;
    await expect(roles).toMatchFileSnapshot("../__golden__/permissions.roles.json");
  });
  it("conditions.ts matches the golden", async () => {
    const conditions = result.files.find((f) => f.path === "src/permissions/conditions.ts")!.content;
    await expect(conditions).toMatchFileSnapshot("../__golden__/permissions.conditions.ts.txt");
  });
  it("bootstrap index.ts matches the golden", async () => {
    const index = result.files.find((f) => f.path === "src/index.ts")!.content;
    await expect(index).toMatchFileSnapshot("../__golden__/permissions.index.ts.txt");
  });
  it("gap report is empty for the user.* fixture", () => {
    expect(result.gaps.gaps).toEqual([]);
  });
  it("regeneration is idempotent", () => {
    const again = strapiAdapter.generate(permissionsBundle, { projectName: "blog" });
    expect(again).toEqual(result);
  });
});
```

- [ ] **Step 6: Exclude goldens from formatting & generate them** — confirm `**/__golden__/**` stays out of Prettier (it is, per repo config). Generate snapshots:
```bash
pnpm --filter @camis/adapter-strapi exec vitest run src/permissions/golden.test.ts -u
```
Then INSPECT the three generated files under `src/__golden__/` (`permissions.roles.json`, `permissions.conditions.ts.txt`, `permissions.index.ts.txt`): verify `roles.json` has `api::article.article` subjects, a field-scoped entry for `secret`, condition names on read/update, and no `publish` gap (Article has draftPublish); verify `conditions.ts.txt` is self-contained (no `@camis/expr`) and contains the editor predicate handler.

- [ ] **Step 7: Run — PASS** — `pnpm --filter @camis/adapter-strapi test` (all green, including the new golden + existing unchanged); `pnpm --filter @camis/adapter-strapi typecheck`.

- [ ] **Step 8: Commit**
```bash
git add packages/adapter-strapi/src/permissions packages/adapter-strapi/src/__fixtures__/permissions.ts packages/adapter-strapi/src/generate.ts packages/adapter-strapi/src/skeleton/templates.ts packages/adapter-strapi/src/__golden__
git commit -m "feat(adapter-strapi): emit roles.json + conditions + bootstrap; permission goldens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: ESLint boundaries, public surfaces, full sweep

**Files:** Modify `eslint.config.js`; verify `packages/adapter-strapi/src/index.ts` and `packages/permissions/src/index.ts` surfaces.

- [ ] **Step 1: Confirm ESLint boundaries** — the adapter rule in `eslint.config.js` forbids only sibling adapters (`["@camis/adapter-*", "!@camis/adapter-kernel"]`); `adapter-strapi → @camis/permissions`, `@camis/expr`, `@camis/expr-ts` are already allowed. Confirm the `adapter-kernel` files are not under a leaf rule that would block `@camis/permissions`. Run `pnpm lint` and fix any boundary violation surfaced (only by adding an allowance, never by loosening sibling-adapter protection).

- [ ] **Step 2: Public surfaces** — `@camis/permissions` exports `role`/`grant`/`fieldRule`/`action`/`ACTIONS`/`validateBundle` + types `Role`/`Grant`/`FieldRule`/`Action`/`IrBundle`. `@camis/adapter-strapi` may optionally re-export `emitPermissions`/`projectPermissions` if useful to the CLI later — add only if a test needs it (YAGNI otherwise).

- [ ] **Step 3: Full sweep** — run, report counts:
```bash
pnpm lint
pnpm -r typecheck
pnpm -r test
```
All green. The emitted-PHP conformance job is unaffected (no PHP here).

- [ ] **Step 4: Commit (only if a fix was needed)**
```bash
git add eslint.config.js packages
git commit -m "chore(phase-5): finalize permission surfaces and boundaries

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** D1 admin RBAC (Tasks 6–9) · D2 model in `permissions`, `IrBundle` not in irDocument (Tasks 3–5) · D3 permissions deps `expr`+`ir-schema` only, no `expr-ts` (Task 3) · D4 `tsRuntimeSource` embeddable runtime (Task 2), embedded in conditions (Task 8) · D5 fail-closed handler (Task 8) · D6 `user.*` context (Tasks 7–8) · D7 `freeVars` gap (Tasks 1, 7) · D8 `validateBundle` references, var-typing deferred (Task 4) · D9 stable hash names + sorted collections (Tasks 6–7) · D10 golden+structural+tie-in, action-UID isolated (Tasks 6–9). Exit criteria: field-rule + condition fixture generates correct admin-RBAC permissions with empty gap (Task 9); lint/typecheck/test green (Task 10).

**Placeholder scan:** none — every step has concrete code/commands. Goldens are generated via `-u` then inspected (Task 9 Step 6), not hand-written.

**Type consistency:** `IrBundle = { document, roles }` (Task 4) used by kernel (5), strapi generate (5,9), fixtures (9). `Role`/`Grant`/`FieldRule`/`Action` (Task 3) consumed by validate (4), project (7), emit (9). `projectPermissions → { roles, conditions, gaps }` with `NamedCondition`/`PermissionEntry`/`EmittedRole` (7) consumed by `conditions.ts` emitter (8) and `emit.ts` (9). `conditionName` (6) used by project (7). `emitConditionsModule`/`handlerBody` (8) used by emit (9) and tests. `tsRuntimeSource` (2) used by conditions emitter (8). `freeVars` (1) used by project (7). `STRAPI_ACTION_UID`/`FIELD_ACCESS_ACTIONS` (6) used by project (7). `emitTs`'s `r.var(data, name)` shape matches the handler's `data` map (8).

**Note for implementers:** generated code embedded as strings (the `conditions.ts` handler, the bootstrap `any`) is NOT linted by our ESLint (it lives in emitted output / `__golden__`, both excluded), so `any` there is acceptable; do NOT introduce `any` in our own package sources.
