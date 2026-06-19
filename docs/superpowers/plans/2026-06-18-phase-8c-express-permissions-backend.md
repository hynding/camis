# Phase 8C (Plan 1 of 2) — Express Security Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the generated Express+Drizzle API security-enforcing — JWT auth seam, IR-projected permissions enforced at action/record/field level, Ring-1 conditions evaluated by the vendored conformance-tested runtime.

**Architecture:** A pure `projectExpressPermissions(doc, roles)` lowers the IR permission model to neutral tables. Emitters write auth wiring (verify/login overwrite; `store.ts` protected seed), a vendored Ring-1 runtime + `emitTs`-emitted condition functions, an `enforce.ts` guard module (data tables + fixed fail-closed helpers), and permission-aware CRUD routes. All of it is confined to `adapter-express`; the only shared touch exports two types from `expr-ts`'s embeddable runtime.

**Tech Stack:** TypeScript (strict, ESM, Vitest), Drizzle, Express, `jsonwebtoken`, `@camis/expr` (`emitTs`, `freeVars`), `@camis/expr-ts` (`tsRuntimeSource`). The generated react-admin SPA is Plan 2.

**Spec:** `docs/superpowers/specs/2026-06-18-phase-8c-express-permissions-admin-design.md` (§§2–5, 7–9).

---

## Conventions (read once)

- Package root for all relative paths below: `packages/adapter-express/`.
- Run a single test file: `pnpm --filter @camis/adapter-express exec vitest run src/<file>.test.ts`.
- Whole package: `pnpm --filter @camis/adapter-express test`; typecheck: `… typecheck`; lint: `… lint`.
- **Golden guard:** never run vitest with `-u` except where a task explicitly says to regenerate a named golden; after any task touching generation, `git status --short packages/adapter-express/src/__golden__/` must show only the goldens that task intends to change.
- Emitted code is data (strings) — `any`/unused inside emitted templates is fine; **our** `.ts` sources must stay `any`-free and lint-clean.
- Every commit message ends with a trailing line: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/expr-ts/src/runtime-source.ts` (modify) | Export `Value`/`EvalResult` from the embeddable runtime. |
| `src/permissions/project.ts` (create) | Pure `projectExpressPermissions(doc, roles)` → grants/conditions/fieldRules/gaps. |
| `src/permissions/ring1.ts` (create) | Vendor `tsRuntimeSource()`; emit `conditions.ts` via `emitTs`. |
| `src/permissions/enforce.ts` (create) | Emit the generated `enforce.ts` guard module (data + fixed fail-closed helpers). |
| `src/auth.ts` (create) | Emit `auth/verify.ts`, `auth/login.ts` (overwrite) + `auth/store.ts` (seed). |
| `src/routes.ts` (modify) | Permission-aware CRUD + list range/sort/`Content-Range` + `DELETE {id}`. |
| `src/skeleton.ts` (modify) | Add `jsonwebtoken` dep; mount `/auth` + `verify` middleware in the server. |
| `src/generate.ts` (modify) | Orchestrate permissions/auth/ring1 emission; merge gaps. |
| `src/__fixtures__/secured.ts` (create) | Catalog-derived bundle WITH roles (conditions + field rules). |
| `src/permissions/*.test.ts`, `src/secured-golden.test.ts` (create) | Unit + golden coverage. |

---

## Task 1: Export `Value`/`EvalResult` from the embeddable runtime

**Files:**
- Modify: `packages/expr-ts/src/runtime-source.ts`
- Test: `packages/expr-ts/src/runtime-source.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test** — create/extend `packages/expr-ts/src/runtime-source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { tsRuntimeSource } from "./runtime-source";

describe("tsRuntimeSource", () => {
  const src = tsRuntimeSource();
  it("exports the embeddable Value and EvalResult types", () => {
    expect(src).toContain("export type Value =");
    expect(src).toContain("export type EvalResult =");
  });
  it("still defines the r runtime", () => {
    expect(src).toContain("export const r");
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/expr-ts exec vitest run src/runtime-source.test.ts`. Expected: FAIL (`Value`/`EvalResult` are not exported).

- [ ] **Step 3: Implement** — in `packages/expr-ts/src/runtime-source.ts`, change the two type lines in `PREAMBLE` to be exported:

```ts
const PREAMBLE = `export type Value = null | boolean | number | string;
type EvalError = "TYPE_MISMATCH" | "DIV_BY_ZERO" | "UNKNOWN_VAR";
export type EvalResult = { ok: true; value: Value } | { ok: false; error: EvalError };
const ok = (value: Value): EvalResult => ({ ok: true, value });
const err = (error: EvalError): EvalResult => ({ ok: false, error });
`;
```

(Only `Value` and `EvalResult` gain `export`; `EvalError`/`ok`/`err` stay module-local.)

- [ ] **Step 4: Run green + regression** — `pnpm --filter @camis/expr-ts test`. If any existing snapshot of `tsRuntimeSource()` exists and now differs, that change is expected — update it with `pnpm --filter @camis/expr-ts exec vitest run <that-file> -u` and confirm the only change is the two `export` keywords. Then `pnpm --filter @camis/expr-ts typecheck` and `lint`.

- [ ] **Step 5: Commit**

```bash
git add packages/expr-ts/src/runtime-source.ts packages/expr-ts/src/runtime-source.test.ts
git commit -m "feat(expr-ts): export Value/EvalResult from the embeddable runtime

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Permission projection (`permissions/project.ts`)

**Files:**
- Create: `src/permissions/project.ts`, `src/permissions/project.test.ts`

- [ ] **Step 1: Write the failing test** — `src/permissions/project.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { projectExpressPermissions } from "./project";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Article",
      kind: "collection",
      fields: [
        { type: "string", name: "title", required: true },
        { type: "string", name: "secretNotes" },
        { type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" },
      ],
    },
    { name: "Author", kind: "collection", fields: [{ type: "string", name: "name", required: true }] },
  ],
  components: [],
};

const roles: Role[] = [
  {
    name: "Editor",
    grants: [
      {
        contentType: "Article",
        actions: ["read", "update", "publish"],
        condition: { kind: "eq", left: { kind: "var", name: "record.title" }, right: { kind: "lit", value: "x" } },
        fieldRules: [
          { field: "secretNotes", access: "read", when: { kind: "eq", left: { kind: "var", name: "user.id" }, right: { kind: "var", name: "record.author" } } },
          { field: "ghost", access: "write" },
        ],
      },
    ],
  },
];

describe("projectExpressPermissions", () => {
  const p = projectExpressPermissions(doc, roles);
  it("collects sorted actions per role/contentType", () => {
    expect(p.grants.Editor!.Article).toEqual(["publish", "read", "update"]);
  });
  it("captures the record condition", () => {
    expect(p.conditions.Editor!.Article!.kind).toBe("eq");
  });
  it("keeps valid field rules and drops unknown-field rules with a gap", () => {
    expect(p.fieldRules.Editor!.Article!.map((r) => r.field)).toEqual(["secretNotes"]);
    expect(p.gaps.some((g) => g.feature === "unknownFieldRule" && g.location.field === "ghost")).toBe(true);
  });
  it("gaps the publish action (no REST analog)", () => {
    expect(p.gaps.some((g) => g.feature === "publishAction")).toBe(true);
  });
  it("gaps a condition referencing a relation field (escapes record.<scalar field>)", () => {
    // record.author is a relation, not in the record scalar set → escaping in the field rule when
    expect(p.gaps.some((g) => g.feature === "conditionContext")).toBe(true);
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/permissions/project.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — `src/permissions/project.ts`:

```ts
import type { Expression } from "@camis/expr";
import { freeVars } from "@camis/expr";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { Action, Role } from "@camis/permissions";

export interface ExpressFieldRule {
  field: string;
  access: "read" | "write";
  when?: Expression;
}
export interface ExpressPermissions {
  roles: string[];
  grants: Record<string, Record<string, Action[]>>; // role → contentType → actions
  conditions: Record<string, Record<string, Expression>>; // role → contentType → record condition
  fieldRules: Record<string, Record<string, ExpressFieldRule[]>>; // role → contentType → rules
  gaps: CapabilityGap[];
}

const recordFieldNames = (ct: ContentType): Set<string> =>
  new Set(ct.fields.filter((f) => f.type !== "relation").map((f) => f.name));

export const projectExpressPermissions = (doc: IrDocument, roles: Role[]): ExpressPermissions => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const grants: Record<string, Record<string, Action[]>> = {};
  const conditions: Record<string, Record<string, Expression>> = {};
  const fieldRules: Record<string, Record<string, ExpressFieldRule[]>> = {};
  const gaps: CapabilityGap[] = [];

  const flagEscaping = (expr: Expression, ctName: string, role: string, fieldOk: Set<string>): void => {
    const escaping = freeVars(expr).filter(
      (v) => !(v.startsWith("user.") || (v.startsWith("record.") && fieldOk.has(v.slice("record.".length)))),
    );
    if (escaping.length > 0) {
      gaps.push({
        feature: "conditionContext",
        location: { contentType: ctName, rule: role },
        severity: "downgrade",
        message: `condition references ${escaping.join(", ")} outside user.* and record.<field>; it will deny`,
      });
    }
  };

  for (const role of [...roles].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const grant of role.grants) {
      const ct = byName.get(grant.contentType);
      if (!ct) continue;
      const fieldOk = recordFieldNames(ct);

      (grants[role.name] ??= {})[grant.contentType] = [
        ...new Set([...(grants[role.name]?.[grant.contentType] ?? []), ...grant.actions]),
      ].sort() as Action[];

      if (grant.actions.includes("publish" as Action)) {
        gaps.push({
          feature: "publishAction",
          location: { contentType: grant.contentType, rule: role.name },
          severity: "downgrade",
          message: `the "publish" action has no REST analog in the Express target; ignored`,
        });
      }

      if (grant.condition) {
        flagEscaping(grant.condition, grant.contentType, role.name, fieldOk);
        (conditions[role.name] ??= {})[grant.contentType] = grant.condition;
      }

      for (const fr of grant.fieldRules ?? []) {
        if (!fieldOk.has(fr.field)) {
          gaps.push({
            feature: "unknownFieldRule",
            location: { contentType: grant.contentType, field: fr.field, rule: role.name },
            severity: "downgrade",
            message: `field rule on "${grant.contentType}.${fr.field}" names a field absent or unsupported; ignored`,
          });
          continue;
        }
        if (fr.when) flagEscaping(fr.when, grant.contentType, role.name, fieldOk);
        const rule: ExpressFieldRule = fr.when
          ? { field: fr.field, access: fr.access, when: fr.when }
          : { field: fr.field, access: fr.access };
        ((fieldRules[role.name] ??= {})[grant.contentType] ??= []).push(rule);
      }
    }
  }

  return { roles: roles.map((r) => r.name).sort(), grants, conditions, fieldRules, gaps };
};
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/permissions/project.test.ts`; then `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add src/permissions/project.ts src/permissions/project.test.ts
git commit -m "feat(adapter-express): project IR permissions to neutral grant/condition/fieldRule tables

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Ring-1 emission (`permissions/ring1.ts`)

**Files:**
- Create: `src/permissions/ring1.ts`, `src/permissions/ring1.test.ts`

Emits two files' content: the vendored runtime, and a `conditions.ts` module of named condition
functions keyed `c__<role>__<Type>__<action>` / `f__<role>__<Type>__<field>__<access>`.

- [ ] **Step 1: Write the failing test** — `src/permissions/ring1.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { conditionKey, fieldRuleKey, emitConditionsFile, ring1RuntimeFile } from "./ring1";

const cond: Expression = { kind: "eq", left: { kind: "var", name: "record.title" }, right: { kind: "lit", value: "x" } };

describe("ring1 emission", () => {
  it("builds deterministic keys", () => {
    expect(conditionKey("Editor", "Article", "read")).toBe("c__Editor__Article__read");
    expect(fieldRuleKey("Editor", "Article", "secretNotes", "read")).toBe("f__Editor__Article__secretNotes__read");
  });
  it("emits a named condition function over the r runtime", () => {
    const file = emitConditionsFile([{ key: "c__Editor__Article__read", expr: cond }]);
    expect(file).toContain('import { r, type EvalResult, type Value } from "../ring1/runtime";');
    expect(file).toContain("export const c__Editor__Article__read = (data: Record<string, Value>): EvalResult =>");
    expect(file).toContain("r.eq(");
  });
  it("vendors the conformance runtime (exports r + Value)", () => {
    const rt = ring1RuntimeFile();
    expect(rt).toContain("export const r");
    expect(rt).toContain("export type Value");
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/permissions/ring1.test.ts`.

- [ ] **Step 3: Implement** — `src/permissions/ring1.ts`:

```ts
import { withMarker } from "@camis/adapter-kernel";
import { emitTs, type Expression } from "@camis/expr";
import { tsRuntimeSource } from "@camis/expr-ts";

export const conditionKey = (role: string, contentType: string, action: string): string =>
  `c__${role}__${contentType}__${action}`;

export const fieldRuleKey = (
  role: string,
  contentType: string,
  field: string,
  access: string,
): string => `f__${role}__${contentType}__${field}__${access}`;

export interface NamedCondition {
  key: string;
  expr: Expression;
}

export const ring1RuntimeFile = (): string => withMarker(tsRuntimeSource());

export const emitConditionsFile = (conditions: NamedCondition[]): string => {
  const body = conditions
    .map(
      (c) =>
        `export const ${c.key} = (data: Record<string, Value>): EvalResult => ${emitTs(c.expr)};`,
    )
    .join("\n");
  return withMarker(`import { r, type EvalResult, type Value } from "../ring1/runtime";

${body}
`);
};
```

(`emitTs` produces `r.eq(() => r.var(data, "record.title"), () => r.lit("x"))` etc. — the bound name
in emitted code is `data`, which matches the function parameter.)

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/permissions/ring1.test.ts`; `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add src/permissions/ring1.ts src/permissions/ring1.test.ts
git commit -m "feat(adapter-express): emit Ring-1 condition functions + vendor the conformance runtime

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Auth seam emitters (`auth.ts`)

**Files:**
- Create: `src/auth.ts`, `src/auth.test.ts`

Emits `auth/store.ts` (seed), `auth/verify.ts` (overwrite), `auth/login.ts` (overwrite). The store
seeds one dev user per role with a **fixed** secret (determinism).

- [ ] **Step 1: Write the failing test** — `src/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { authFiles } from "./auth";

describe("authFiles", () => {
  const files = authFiles(["Editor", "Viewer"]);
  const byPath = (p: string) => files.find((f) => f.path === p)!;
  it("emits a protected (seed) store with one dev user per role and a fixed secret", () => {
    const store = byPath("src/auth/store.ts");
    expect(store.mode).toBe("seed");
    expect(store.content).toContain('role: "Editor"');
    expect(store.content).toContain('role: "Viewer"');
    expect(store.content).toContain('export const jwtSecret = "dev-secret-change-me";');
  });
  it("emits overwrite verify middleware that hydrates the user from the store", () => {
    const verify = byPath("src/auth/verify.ts");
    expect(verify.mode ?? "overwrite").toBe("overwrite");
    expect(verify.content).toContain("getUser(payload.sub)");
    expect(verify.content).toContain("req.camisUser");
  });
  it("emits an overwrite login route that signs a JWT", () => {
    expect(byPath("src/auth/login.ts").content).toContain('authRouter.post("/login"');
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/auth.test.ts`.

- [ ] **Step 3: Implement** — `src/auth.ts`:

```ts
import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";

const storeFile = (roles: string[]): string => {
  const users = roles
    .map(
      (role, i) =>
        `  { id: ${i + 1}, role: ${JSON.stringify(role)}, email: ${JSON.stringify(
          `${role.toLowerCase()}@example.com`,
        )}, password: "dev" },`,
    )
    .join("\n");
  // No marker: this is a protected, hand-editable seed file.
  return `// camis dev auth stub — REPLACE FOR PRODUCTION (real user store, hashing, secret from env).
export interface CamisUser {
  id: number;
  role: string;
  email: string;
}

const USERS: (CamisUser & { password: string })[] = [
${users}
];

export const jwtSecret = "dev-secret-change-me";

export const verifyCredentials = (email: string, password: string): CamisUser | null => {
  const u = USERS.find((x) => x.email === email && x.password === password);
  return u ? { id: u.id, role: u.role, email: u.email } : null;
};

export const getUser = (id: number): CamisUser | null => {
  const u = USERS.find((x) => x.id === id);
  return u ? { id: u.id, role: u.role, email: u.email } : null;
};
`;
};

const VERIFY = withMarker(`import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { getUser, jwtSecret, type CamisUser } from "./store";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      camisUser?: CamisUser;
    }
  }
}

export const verify = (req: Request, _res: Response, next: NextFunction): void => {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (token) {
    try {
      const payload = jwt.verify(token, jwtSecret) as { sub: number };
      const user = getUser(payload.sub);
      if (user) req.camisUser = user;
    } catch {
      /* invalid/expired token → treated as anonymous */
    }
  }
  next();
};
`);

const LOGIN = withMarker(`import { Router } from "express";
import jwt from "jsonwebtoken";
import { jwtSecret, verifyCredentials } from "./store";

export const authRouter = Router();

authRouter.post("/login", (req, res) => {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  const user = verifyCredentials(String(email), String(password));
  if (!user) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  const token = jwt.sign({ sub: user.id, role: user.role }, jwtSecret, { expiresIn: "12h" });
  res.json({ token, user });
});
`);

export const authFiles = (roles: string[]): GeneratedFile[] => [
  { path: "src/auth/store.ts", content: storeFile(roles), mode: "seed" },
  { path: "src/auth/verify.ts", content: VERIFY },
  { path: "src/auth/login.ts", content: LOGIN },
];
```

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/auth.test.ts`; `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/auth.test.ts
git commit -m "feat(adapter-express): emit JWT auth seam (verify/login overwrite, store seed)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Enforcement guard module (`permissions/enforce.ts`)

**Files:**
- Create: `src/permissions/enforce.ts`, `src/permissions/enforce.test.ts`

Emits the generated `src/permissions/enforce.ts` of the target project: fixed fail-closed helper logic
+ generated data literals (grants, condition-key map, field rules, column→field map, condition
registry). `emitEnforce(permissions, doc)` returns the file string.

- [ ] **Step 1: Write the failing test** — `src/permissions/enforce.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { emitEnforce } from "./enforce";
import type { ExpressPermissions } from "./project";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "secretNotes" }] },
  ],
  components: [],
};

const perms: ExpressPermissions = {
  roles: ["Editor"],
  grants: { Editor: { Article: ["read", "update"] } },
  conditions: { Editor: { Article: { kind: "lit", value: true } } },
  fieldRules: { Editor: { Article: [{ field: "secretNotes", access: "read" }] } },
  gaps: [],
};

describe("emitEnforce", () => {
  const file = emitEnforce(perms, doc);
  it("emits fail-closed allow + the guard helpers", () => {
    expect(file).toContain("const allow = (res: EvalResult): boolean => res.ok && res.value === true;");
    expect(file).toContain("export const authorizeAction");
    expect(file).toContain("export const recordAllowed");
    expect(file).toContain("export const filterRead");
    expect(file).toContain("export const stripWrites");
  });
  it("embeds the grants and the column->field map", () => {
    expect(file).toContain('"Editor"');
    expect(file).toContain('"secret_notes": "secretNotes"'); // snake column → IR field
  });
  it("wires a condition registry keyed by the grant record-condition key", () => {
    expect(file).toContain("c__Editor__Article__record"); // grant record condition key (action segment = "record")
  });
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/permissions/enforce.test.ts`.

- [ ] **Step 3: Implement** — `src/permissions/enforce.ts`:

```ts
import { stableJson, withMarker } from "@camis/adapter-kernel";
import type { IrDocument } from "@camis/ir-schema";
import { snakeColumn } from "../names";
import { conditionKey, fieldRuleKey } from "./ring1";
import type { ExpressPermissions } from "./project";

// Build the per-contentType { snake_column: irFieldName } map so record.* conditions, authored
// against IR field names, resolve against the snake_case Drizzle row.
const columnToField = (doc: IrDocument): Record<string, Record<string, string>> => {
  const out: Record<string, Record<string, string>> = {};
  for (const ct of doc.contentTypes) {
    const m: Record<string, string> = {};
    for (const f of ct.fields) if (f.type !== "relation") m[snakeColumn(f.name)] = f.name;
    out[ct.name] = m;
  }
  return out;
};

export const emitEnforce = (perms: ExpressPermissions, doc: IrDocument): string => {
  // Condition-key map: role → contentType → registry key (only where a grant condition exists).
  const condKeys: Record<string, Record<string, string>> = {};
  const registryEntries: string[] = [];
  for (const [role, byCt] of Object.entries(perms.conditions)) {
    for (const ct of Object.keys(byCt)) {
      const key = conditionKey(role, ct, "record");
      (condKeys[role] ??= {})[ct] = key;
      registryEntries.push(`  ${key}: C.${key},`);
    }
  }
  // Field-rule conditional keys → registry too.
  const fieldRuleKeys: Record<string, Record<string, { field: string; access: string; key?: string }[]>> = {};
  for (const [role, byCt] of Object.entries(perms.fieldRules)) {
    for (const [ct, rules] of Object.entries(byCt)) {
      fieldRuleKeys[role] ??= {};
      fieldRuleKeys[role][ct] = rules.map((r) => {
        if (!r.when) return { field: r.field, access: r.access };
        const key = fieldRuleKey(role, ct, r.field, r.access);
        registryEntries.push(`  ${key}: C.${key},`);
        return { field: r.field, access: r.access, key };
      });
    }
  }

  const data = `const GRANTS = ${stableJson(perms.grants)} as Record<string, Record<string, string[]>>;
const COND_KEY = ${stableJson(condKeys)} as Record<string, Record<string, string>>;
const FIELD_RULES = ${stableJson(fieldRuleKeys)} as Record<string, Record<string, { field: string; access: string; key?: string }[]>>;
const COLUMN_TO_FIELD = ${stableJson(columnToField(doc))} as Record<string, Record<string, string>>;
const REGISTRY: Record<string, (data: Record<string, Value>) => EvalResult> = {
${registryEntries.sort().join("\n")}
};`;

  return withMarker(`import type { Request } from "express";
import type { EvalResult, Value } from "../ring1/runtime";
import * as C from "./conditions";

${data}

// Fail-closed: only an explicit { ok: true, value: true } may allow.
const allow = (res: EvalResult): boolean => res.ok && res.value === true;

export const roleOf = (req: Request): string => req.camisUser?.role ?? "public";

const flattenUser = (req: Request): Record<string, Value> => {
  const out: Record<string, Value> = {};
  const u = (req.camisUser ?? { role: "public" }) as Record<string, Value>;
  for (const [k, v] of Object.entries(u)) out[\`user.\${k}\`] = v as Value;
  return out;
};

const flattenRecord = (ct: string, row: Record<string, unknown>): Record<string, Value> => {
  const map = COLUMN_TO_FIELD[ct] ?? {};
  const out: Record<string, Value> = {};
  for (const [col, val] of Object.entries(row)) {
    const field = map[col];
    if (field) out[\`record.\${field}\`] = val as Value;
  }
  return out;
};

export const authorizeAction = (role: string, ct: string, action: string): boolean =>
  (GRANTS[role]?.[ct] ?? []).includes(action);

export const recordAllowed = (
  req: Request,
  ct: string,
  row: Record<string, unknown>,
): boolean => {
  const key = COND_KEY[roleOf(req)]?.[ct];
  if (!key) return true;
  const fn = REGISTRY[key];
  if (!fn) return false;
  return allow(fn({ ...flattenUser(req), ...flattenRecord(ct, row) }));
};

const fieldVisible = (
  req: Request,
  ct: string,
  rule: { field: string; access: string; key?: string },
  row: Record<string, unknown>,
): boolean => {
  if (!rule.key) return true;
  const fn = REGISTRY[rule.key];
  if (!fn) return false;
  return allow(fn({ ...flattenUser(req), ...flattenRecord(ct, row) }));
};

export const filterRead = (
  req: Request,
  ct: string,
  row: Record<string, unknown>,
): Record<string, unknown> => {
  const rules = (FIELD_RULES[roleOf(req)]?.[ct] ?? []).filter((r) => r.access === "read");
  if (rules.length === 0) return row;
  const out = { ...row };
  const colOf = Object.fromEntries(
    Object.entries(COLUMN_TO_FIELD[ct] ?? {}).map(([col, field]) => [field, col]),
  );
  for (const rule of rules) {
    if (!fieldVisible(req, ct, rule, row)) delete out[colOf[rule.field] ?? rule.field];
  }
  return out;
};

export const stripWrites = (
  req: Request,
  ct: string,
  proposed: Record<string, unknown>,
  body: Record<string, unknown>,
): Record<string, unknown> => {
  const rules = (FIELD_RULES[roleOf(req)]?.[ct] ?? []).filter((r) => r.access === "write");
  if (rules.length === 0) return body;
  const out = { ...body };
  const colOf = Object.fromEntries(
    Object.entries(COLUMN_TO_FIELD[ct] ?? {}).map(([col, field]) => [field, col]),
  );
  for (const rule of rules) {
    if (!fieldVisible(req, ct, rule, proposed)) delete out[colOf[rule.field] ?? rule.field];
  }
  return out;
};
`);
};
```

(Note the condition registry key for a grant record-condition is `c__<role>__<Type>__record`; Task 6's
`generate` must emit the matching condition function under that same key. Field-rule write/read
conditions evaluate against the *proposed* / stored record respectively, handled by the caller in
Task 6.)

- [ ] **Step 4: Run green** — `pnpm --filter @camis/adapter-express exec vitest run src/permissions/enforce.test.ts`; `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add src/permissions/enforce.ts src/permissions/enforce.test.ts
git commit -m "feat(adapter-express): emit fail-closed enforcement guards (action/record/field)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Permission-aware routes + react-admin REST contract (`routes.ts`)

**Files:**
- Modify: `src/routes.ts`, `src/routes.test.ts`

The route emitter gains a `secured` flag (default `false`, so 8A/8B route goldens stay byte-identical).
When `secured`, handlers call the Task-5 guards and the list endpoint honors `_start/_end/_sort/_order`
+ sets `Content-Range`; `DELETE` returns `{ id }`.

- [ ] **Step 1: Write the failing test** — extend `src/routes.test.ts`:

```ts
it("unsecured routes are unchanged (no guard imports)", () => {
  const ts = emitRoutes(article, []);
  expect(ts).not.toContain("authorizeAction");
});
it("secured routes import guards, gate actions, filter reads, and return {id} on delete", () => {
  const ts = emitRoutes(article, [], { secured: true });
  expect(ts).toContain('import { authorizeAction, recordAllowed, filterRead, stripWrites, roleOf } from "../permissions/enforce";');
  expect(ts).toContain('authorizeAction(roleOf(req), "Article", "read")');
  expect(ts).toContain("filterRead(req,");
  expect(ts).toContain('res.json({ id: Number(req.params.id) });');
  expect(ts).toContain('res.setHeader("Content-Range"');
});
```

(The existing `emitRoutes(article, ["author_id"])` / `emitRoutes(article, [])` tests stay; the new
3rd arg is optional.)

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/routes.test.ts`.

- [ ] **Step 3: Implement** — replace `src/routes.ts` with:

```ts
import { withMarker } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { isSupportedField } from "./fields";
import { expressNames, snakeColumn } from "./names";

export interface RouteOptions {
  secured?: boolean;
}

export const emitRoutes = (
  ct: ContentType,
  fkColumns: string[] = [],
  options: RouteOptions = {},
): string => {
  const n = expressNames(ct);
  const t = n.table;
  const typeName = ct.name;
  const cols = [
    ...ct.fields.filter((f) => isSupportedField(f.type)).map((f) => snakeColumn(f.name)),
    ...fkColumns,
  ]
    .map((c) => `"${c}"`)
    .join(", ");

  if (!options.secured) {
    return withMarker(`import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { ${t} } from "../db/schema";

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

${t}Router.post("/", (req, res) => {
  const data = pick(req.body, [${cols}]);
  const row = db.insert(${t}).values(data).returning().get();
  res.status(201).json(row);
});

${t}Router.patch("/:id", (req, res) => {
  const data = pick(req.body, [${cols}]);
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
import { authorizeAction, recordAllowed, filterRead, stripWrites, roleOf } from "../permissions/enforce";

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

${t}Router.post("/", (req, res) => {
  if (!authorizeAction(roleOf(req), "${typeName}", "create")) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const proposed = pick(req.body, [${cols}]);
  const data = stripWrites(req, "${typeName}", proposed, proposed);
  const row = db.insert(${t}).values(data).returning().get();
  res.status(201).json(filterRead(req, "${typeName}", row));
});

${t}Router.patch("/:id", (req, res) => {
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
  const data = stripWrites(req, "${typeName}", { ...existing, ...incoming }, incoming);
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

- [ ] **Step 4: Run green + regression** — `pnpm --filter @camis/adapter-express test`. The 8A/8B route goldens use the default (`secured` omitted) path and MUST stay byte-identical: `git status --short src/__golden__/` empty. `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts src/routes.test.ts
git commit -m "feat(adapter-express): permission-aware routes + react-admin REST list/delete contract

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Skeleton wiring — JWT dep + mount auth/verify (`skeleton.ts`)

**Files:**
- Modify: `src/skeleton.ts`, `src/skeleton.test.ts`

The server must `app.use(verify)` and mount `authRouter` at `/auth`; package.json gains `jsonwebtoken`.
Gate this behind a `secured` flag so 8A/8B skeleton goldens stay byte-identical.

- [ ] **Step 1: Write the failing test** — extend `src/skeleton.test.ts`:

```ts
it("unsecured server has no auth wiring (8A/8B compatible)", () => {
  const files = skeletonFiles(doc, "blog", "sqlite");
  expect(files.find((f) => f.path === "src/server.ts")!.content).not.toContain("authRouter");
});
it("secured server mounts verify + /auth and adds jsonwebtoken", () => {
  const files = skeletonFiles(doc, "blog", "sqlite", { secured: true });
  const server = files.find((f) => f.path === "src/server.ts")!.content;
  expect(server).toContain('import { verify } from "./auth/verify";');
  expect(server).toContain('app.use("/auth", authRouter);');
  expect(server).toContain("app.use(verify);");
  expect(JSON.parse(files.find((f) => f.path === "package.json")!.content).dependencies["jsonwebtoken"]).toBeDefined();
});
```

(Update existing `skeletonFiles(doc, "blog", "sqlite")` calls — they keep working since the 4th arg is optional.)

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/skeleton.test.ts`.

- [ ] **Step 3: Implement** — in `src/skeleton.ts`:
  1. Add an options param: `export const skeletonFiles = (doc: IrDocument, projectName: string, dialect: Dialect, options: { secured?: boolean } = {}): GeneratedFile[] => { ... }`.
  2. In `PACKAGE_JSON(projectName, spec, secured)`, when `secured`, merge `{ jsonwebtoken: "^9.0.0" }` into `dependencies` (after `express`) and `{ "@types/jsonwebtoken": "^9.0.0" }` into `devDependencies` (after `@types/express`). Thread `options.secured` through.
  3. Replace `emitServer(doc)` with `emitServer(doc, secured)`. When `secured`, the server emits the auth imports and wiring:

```ts
const emitServer = (doc: IrDocument, secured: boolean): string => {
  const cts = doc.contentTypes;
  const routerImports = cts
    .map((ct) => `import { ${expressNames(ct).table}Router } from "./routes/${expressNames(ct).table}";`)
    .join("\n");
  const mounts = cts
    .map((ct) => `app.use("/api/${expressNames(ct).routeBase}", ${expressNames(ct).table}Router);`)
    .join("\n");
  const authImports = secured
    ? `\nimport { verify } from "./auth/verify";\nimport { authRouter } from "./auth/login";`
    : "";
  const authWiring = secured ? `app.use(verify);\napp.use("/auth", authRouter);\n` : "";
  return withMarker(`import express from "express";
${routerImports}${authImports}

export const app = express();
app.use(express.json());
${authWiring}${mounts}
app.use((_req, res) => {
  res.status(404).json({ error: "not found" });
});
`);
};
```

  Keep the sqlite/unsecured output byte-identical (when `secured` is false, `authImports` and
  `authWiring` are empty strings, so the template equals 8A/8B exactly).

- [ ] **Step 4: Run green + regression** — `pnpm --filter @camis/adapter-express test`; `git status --short src/__golden__/` empty (unsecured path unchanged); `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add src/skeleton.ts src/skeleton.test.ts
git commit -m "feat(adapter-express): secured skeleton wiring (verify middleware + /auth mount + jsonwebtoken)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Orchestration (`generate.ts`)

**Files:**
- Modify: `src/generate.ts`, `src/generate.test.ts`

When `ir.roles` is non-empty, the adapter emits the secured variant: auth files, vendored runtime,
condition functions, enforce module, and threads `secured: true` into routes + skeleton. Gaps from the
projection merge into the result. When `ir.roles` is empty, output is exactly 8B (back-compatible).

- [ ] **Step 1: Write the failing test** — extend `src/generate.test.ts`:

```ts
it("with no roles, output matches 8B (no auth/permissions files)", () => {
  const r = expressAdapter.generate({ document: { version: 1, contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }] }], components: [] }, roles: [] } as never, { projectName: "blog" });
  expect(r.files.some((f) => f.path.startsWith("src/auth/"))).toBe(false);
  expect(r.files.some((f) => f.path === "src/permissions/enforce.ts")).toBe(false);
});
it("with roles, emits auth + permissions + ring1 + secured routes and merges gaps", () => {
  const bundle = { document: { version: 1, contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }, { type: "string", name: "secretNotes" }] },
  ], components: [] }, roles: [
    { name: "Editor", grants: [{ contentType: "Article", actions: ["read", "update"], condition: { kind: "eq", left: { kind: "var", name: "record.title" }, right: { kind: "lit", value: "x" } }, fieldRules: [{ field: "secretNotes", access: "read" }] }] },
  ] } as never;
  const r = expressAdapter.generate(bundle, { projectName: "blog" });
  const paths = r.files.map((f) => f.path);
  expect(paths).toContain("src/auth/store.ts");
  expect(paths).toContain("src/auth/verify.ts");
  expect(paths).toContain("src/ring1/runtime.ts");
  expect(paths).toContain("src/permissions/conditions.ts");
  expect(paths).toContain("src/permissions/enforce.ts");
  const routes = r.files.find((f) => f.path === "src/routes/articles.ts")!.content;
  expect(routes).toContain("authorizeAction");
  const conditions = r.files.find((f) => f.path === "src/permissions/conditions.ts")!.content;
  expect(conditions).toContain("c__Editor__Article__record"); // grant condition key
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-express exec vitest run src/generate.test.ts`.

- [ ] **Step 3: Implement** — update `src/generate.ts`. Add imports and, inside `generate`, after the existing relation resolution and gap loop, branch on roles:

```ts
import { authFiles } from "./auth";
import { projectExpressPermissions } from "./permissions/project";
import { emitConditionsFile, ring1RuntimeFile, conditionKey, fieldRuleKey, type NamedCondition } from "./permissions/ring1";
import { emitEnforce } from "./permissions/enforce";
```

Replace the body so that:
1. `const secured = ir.roles.length > 0;`
2. Routes use `emitRoutes(ct, fkNames(fk), { secured })`.
3. Skeleton uses `skeletonFiles(doc, options.projectName, dialect, { secured })`.
4. When `secured`:
   - `const perms = projectExpressPermissions(doc, ir.roles);` and `gaps.push(...perms.gaps);`
   - `files.push(...authFiles(perms.roles));`
   - `files.push({ path: "src/ring1/runtime.ts", content: ring1RuntimeFile() });`
   - Build the `NamedCondition[]` (grant conditions keyed `conditionKey(role, ct, "record")`, conditional field rules keyed `fieldRuleKey(role, ct, field, access)`), then `files.push({ path: "src/permissions/conditions.ts", content: emitConditionsFile(named) });`
   - `files.push({ path: "src/permissions/enforce.ts", content: emitEnforce(perms, doc) });`

The `NamedCondition[]` builder (place as a module-level helper in `generate.ts`):

```ts
const namedConditions = (perms: ReturnType<typeof projectExpressPermissions>): NamedCondition[] => {
  const out: NamedCondition[] = [];
  for (const [role, byCt] of Object.entries(perms.conditions)) {
    for (const [ct, expr] of Object.entries(byCt)) {
      out.push({ key: conditionKey(role, ct, "record"), expr });
    }
  }
  for (const [role, byCt] of Object.entries(perms.fieldRules)) {
    for (const [ct, rules] of Object.entries(byCt)) {
      for (const rule of rules) {
        if (rule.when) out.push({ key: fieldRuleKey(role, ct, rule.field, rule.access), expr: rule.when });
      }
    }
  }
  return out;
};
```

(Keep the existing schema/camis.schema.json/relations emission untouched. The condition registry key
in `enforce.ts` for a grant condition is `c__<role>__<Type>__record` — it must match what
`namedConditions` emits; both derive from `conditionKey(role, ct, "record")`.)

- [ ] **Step 4: Run green + regression** — `pnpm --filter @camis/adapter-express test`; the 8A/8B goldens (roles empty) MUST be unchanged: `git status --short src/__golden__/` empty; `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add src/generate.ts src/generate.test.ts
git commit -m "feat(adapter-express): orchestrate secured generation when the bundle carries roles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Secured fixture + goldens + gap assertions

**Files:**
- Create: `src/__fixtures__/secured.ts`, `src/secured-golden.test.ts`, golden dir `src/__golden__/secured/`

- [ ] **Step 1: Fixture** — `src/__fixtures__/secured.ts` (a small but representative bundle: a record
  condition, a conditional read field rule, an unconditional write field rule, a `public` role, and a
  `publish` grant to exercise the gap):

```ts
import type { IrBundle } from "@camis/permissions";

export const secured: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "string", name: "status" },
          { type: "string", name: "secretNotes" },
          { type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" },
        ],
      },
      { name: "Author", kind: "collection", fields: [{ type: "string", name: "name", required: true }] },
    ],
    components: [],
  },
  roles: [
    {
      name: "Editor",
      grants: [
        {
          contentType: "Article",
          actions: ["create", "read", "update", "delete", "publish"],
          fieldRules: [{ field: "secretNotes", access: "write" }],
        },
        { contentType: "Author", actions: ["create", "read", "update", "delete"] },
      ],
    },
    {
      name: "Viewer",
      grants: [
        {
          contentType: "Article",
          actions: ["read"],
          condition: { kind: "eq", left: { kind: "var", name: "record.status" }, right: { kind: "lit", value: "published" } },
          fieldRules: [
            { field: "secretNotes", access: "read", when: { kind: "eq", left: { kind: "var", name: "user.id" }, right: { kind: "var", name: "record.title" } } },
          ],
        },
        { contentType: "Author", actions: ["read"] },
      ],
    },
    { name: "public", grants: [{ contentType: "Article", actions: ["read"], condition: { kind: "eq", left: { kind: "var", name: "record.status" }, right: { kind: "lit", value: "published" } } }] },
  ],
};
```

- [ ] **Step 2: Golden test** — `src/secured-golden.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { expressAdapter } from "./generate";
import { secured } from "./__fixtures__/secured";

describe("secured golden", () => {
  const result = expressAdapter.generate(secured, { projectName: "blog" });
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("conditions golden", async () => {
    await expect(c("src/permissions/conditions.ts")).toMatchFileSnapshot("./__golden__/secured/conditions.ts.txt");
  });
  it("enforce golden", async () => {
    await expect(c("src/permissions/enforce.ts")).toMatchFileSnapshot("./__golden__/secured/enforce.ts.txt");
  });
  it("auth store golden (seed)", async () => {
    await expect(c("src/auth/store.ts")).toMatchFileSnapshot("./__golden__/secured/store.ts.txt");
  });
  it("secured articles routes golden", async () => {
    await expect(c("src/routes/articles.ts")).toMatchFileSnapshot("./__golden__/secured/articles.routes.ts.txt");
  });
  it("server golden (auth wiring)", async () => {
    await expect(c("src/server.ts")).toMatchFileSnapshot("./__golden__/secured/server.ts.txt");
  });
  it("file-listing golden", async () => {
    await expect(result.files.map((f) => `${f.mode ?? "overwrite"} ${f.path}`).sort().join("\n")).toMatchFileSnapshot("./__golden__/secured/file-listing.txt");
  });
  it("reports the publishAction gap (Editor grants publish, no REST analog)", () => {
    expect(result.gaps.gaps.some((g) => g.feature === "publishAction")).toBe(true);
  });
  it("is idempotent", () => {
    expect(expressAdapter.generate(secured, { projectName: "blog" })).toEqual(result);
  });
});
```

(If the `conditionContext` assertion does not hold for this fixture — `record.title`/`record.status`
are valid scalar fields, so they do **not** escape — change that assertion to target a deliberately
escaping rule, OR drop it and keep only the `publishAction` gap assertion. Decide by reading the
generated gaps; do not force a wrong golden. The `publishAction` gap is guaranteed by the Editor's
`publish` grant.)

- [ ] **Step 3: Generate + INSPECT** — `pnpm --filter @camis/adapter-express exec vitest run src/secured-golden.test.ts -u`. Read each new golden and confirm:
  - `conditions.ts.txt`: `c__Viewer__Article__record`, `c__public__Article__record`, `f__Viewer__Article__secretNotes__read` functions over `r.*`.
  - `enforce.ts.txt`: GRANTS includes Editor/Viewer/public; `"secret_notes": "secretNotes"` in COLUMN_TO_FIELD; REGISTRY wires the condition keys; `allow = (res) => res.ok && res.value === true`.
  - `store.ts.txt`: three dev users (editor/viewer/public), fixed secret, NO `@camis:generated` marker (it is a seed file).
  - `articles.routes.ts.txt`: action gates, `filterRead`, `Content-Range`, `{ id: Number(... }` on delete.
  - `server.ts.txt`: `app.use(verify)` + `/auth` mount.

- [ ] **Step 4: Regression** — `pnpm --filter @camis/adapter-express test`; `git status --short src/__golden__/` shows ONLY new files under `secured/` (the 8A `__golden__/*` and 8B `__golden__/catalog/*` unchanged). `… typecheck`; `… lint`.

- [ ] **Step 5: Commit**

```bash
git add src/__fixtures__/secured.ts src/secured-golden.test.ts src/__golden__/secured
git commit -m "test(adapter-express): secured fixture + permission/auth/ring1 goldens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Gated boot — login + enforcement (denied paths)

**Files:**
- Modify: `packages/adapter-express/scripts/boot-smoke.ts`

Extend the existing dialect-parameterized smoke (it already generates the catalog, pushes, boots). Add
a roles-bearing path: generate the `secured` fixture, log in as Editor, prove an **allowed** create +
read works, prove an **anonymous** (no token) mutate is **denied** (403), and prove the Viewer's
record condition filters a non-`published` row (denied read ⇒ 404). The admin build is Plan 2.

- [ ] **Step 1: Implement** — in `packages/adapter-express/scripts/boot-smoke.ts`, switch the fixture to
  `secured` and add the auth + enforcement assertions. Replace the fixture import and the CRUD block:

```ts
import { secured } from "../src/__fixtures__/secured";
// ...
await materialize(expressAdapterFor(dialect).generate(secured, { projectName: "blog" }), dir);
// ... install, db:push, spawn start, waitForServer on `${root}/articles` (will 403 without a token —
// waitForServer accepts status < 500, so a 403 still signals "up"). ...

const login = async (email: string): Promise<string> => {
  const res = await fetch(`${root}/auth`.replace("/api", "") + "/login", {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password: "dev" }),
  });
  if (res.status !== 200) {
    console.error(`login ${email} → ${res.status}`);
    process.exit(1);
  }
  return ((await res.json()) as { token: string }).token;
};
```

  (Note: `root` is `http://127.0.0.1:3210/api`; the auth router mounts at `/auth`, so login is
  `http://127.0.0.1:3210/auth/login`. Compute it explicitly as `const authBase =
  "http://127.0.0.1:3210/auth";` rather than string-replacing.) Then the assertions:

```ts
const authBase = "http://127.0.0.1:3210/auth";
const editorToken = await (async () => {
  const res = await fetch(`${authBase}/login`, { method: "POST", headers, body: JSON.stringify({ email: "editor@example.com", password: "dev" }) });
  if (res.status !== 200) { console.error(`editor login ${res.status}`); process.exit(1); }
  return ((await res.json()) as { token: string }).token;
})();
const auth = (token: string) => ({ ...headers, authorization: `Bearer ${token}` });

// allowed: Editor creates + reads a published Article
const created = await fetch(`${root}/articles`, { method: "POST", headers: auth(editorToken), body: JSON.stringify({ title: "hello", status: "published" }) });
if (created.status !== 201) { console.error(`editor create ${created.status}`); process.exit(1); }
const { id } = (await created.json()) as { id: number };

// denied: anonymous create → 403
const anon = await fetch(`${root}/articles`, { method: "POST", headers, body: JSON.stringify({ title: "nope" }) });
if (anon.status !== 403) { console.error(`anon create expected 403, got ${anon.status}`); process.exit(1); }

// Viewer record condition: a draft Article is invisible (404) to Viewer
const draft = await fetch(`${root}/articles`, { method: "POST", headers: auth(editorToken), body: JSON.stringify({ title: "secret", status: "draft" }) });
const draftId = ((await draft.json()) as { id: number }).id;
const viewerToken = await (async () => {
  const res = await fetch(`${authBase}/login`, { method: "POST", headers, body: JSON.stringify({ email: "viewer@example.com", password: "dev" }) });
  return ((await res.json()) as { token: string }).token;
})();
const viewerSeesDraft = await fetch(`${root}/articles/${draftId}`, { headers: auth(viewerToken) });
if (viewerSeesDraft.status !== 404) { console.error(`viewer should not see draft, got ${viewerSeesDraft.status}`); process.exit(1); }
const viewerSeesPublished = await fetch(`${root}/articles/${id}`, { headers: auth(viewerToken) });
if (viewerSeesPublished.status !== 200) { console.error(`viewer should see published, got ${viewerSeesPublished.status}`); process.exit(1); }

console.log(`EXPRESS SECURED BOOT SMOKE PASS (${dialect})`);
```

  Remove the old Author/article-FK CRUD block (the secured fixture has Article+Author; the relation FK
  still exists, but the smoke now centers on enforcement). Keep the temp-dir cleanup `finally`.

- [ ] **Step 2: Typecheck the script** — `pnpm --filter @camis/adapter-express exec tsc --noEmit --module ESNext --moduleResolution Bundler --target ESNext --strict --skipLibCheck scripts/boot-smoke.ts` (expect no output). The workflow matrix from 8B is unchanged (still `[sqlite, mysql, pgsql]`); the `DATABASE_URL` env per dialect already feeds it.

- [ ] **Step 3: Full sweep** — `pnpm lint`; `pnpm -r typecheck`; `pnpm -r test` (report counts). Confirm the only golden additions are `src/__golden__/secured/*`. Do NOT run the gated workflow locally.

- [ ] **Step 4: Commit**

```bash
git add packages/adapter-express/scripts/boot-smoke.ts
git commit -m "ci(adapter-express): gated boot proves login + enforced denied paths

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** D1 (one phase, this plan is its backend half) · D2 thin auth seam — Task 4 (verify/login overwrite, store seed) · D3 pure projection — Task 2 · D4 three-level fail-closed enforcement, field rules enforced — Tasks 5,6 · D5 Ring-1 via `emitTs` + vendored `tsRuntimeSource` — Tasks 1,3 · D6 guards inside route handlers — Task 6 · D8 fail-closed `allow` — Task 5. §3 anonymous→`public` — Task 5 `roleOf`. §4.3 react-admin REST contract — Task 6. §4.2 `record.*` snake→IR-field remap — Task 5 `COLUMN_TO_FIELD`/`flattenRecord`. §5 condition keys — Task 3. §8 unit+golden+boot denied-paths — Tasks 2–10. (D7/§6 react-admin sub-app = **Plan 2**, intentionally out of scope here.)

**Placeholder scan:** No "TBD/TODO". The `conditionContext` gap path is unit-covered in Task 2 (the relation-field `when`); Task 9 asserts only the `publishAction` gap, which the secured fixture guarantees (Editor's `publish` grant). All emitter code blocks are complete literals.

**Type consistency:** `ExpressPermissions`/`ExpressFieldRule` (Task 2) consumed by enforce (5) + generate (8). `conditionKey(role, ct, "record")` (Task 3) is the single source for both the emitted condition function (Task 8 `namedConditions`) and the registry key (Task 5 `emitEnforce`). `emitRoutes(ct, fk, { secured })` (Task 6) called by generate (8). `skeletonFiles(doc, name, dialect, { secured })` (Task 7) called by generate (8). `authFiles(roles)` (Task 4) → generate (8). `Value`/`EvalResult` exported in Task 1, imported by the vendored runtime consumers (Tasks 3,5).
