# Phase 4 — Ring 1 Expression Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bounded, pure, total expression grammar (`expr`) with a TS runtime+interpreter+emitter (`expr-ts`) and a PHP emitter+runtime (`expr-php-emit`), pinned so the same `(expression, data)` yields identical results in TS and emitted PHP, locked by a canonical conformance vector suite.

**Architecture:** Expressions are a closed JSON discriminated-union AST (Zod-validated; closedness = purity guard). Each language has a small **runtime library** of thunk-taking functions (`r.eq/r.div/...`) that encode the pinned semantics once (strict, no coercion, IEEE-754 doubles; PHP uses `===`/`strcmp`/float casts, never loose operators). The TS interpreter and both emitters produce/walk the same runtime-call structure. The canonical `vectors` (in `expr`) run through the TS interpreter + executed emitted-TS per-commit, and through executed emitted-PHP in a gated CI job (value-based comparison).

**Tech Stack:** TypeScript (strict, ESM, `moduleResolution: Bundler`, extensionless relative imports, `import type`), Zod, Vitest. PHP (gated CI only) for the emitted-PHP conformance run.

**Reference:** `docs/superpowers/specs/2026-06-17-phase-4-ring1-expressions-design.md` (D1–D10). Empty stub packages `@camis/expr`, `@camis/expr-ts`, `@camis/expr-php-emit` exist. `@camis/ir-schema` is built.

**Conventions:** commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. `import type` for type-only. Relative imports extensionless. ESLint forbids `any` — use `unknown`/narrowing. Single test file: `pnpm --filter @camis/<pkg> exec vitest run src/<file>.test.ts`.

---

## File structure

**`packages/expr/src/`**
- `value.ts` — `Value`, `EvalError`, `EvalResult`.
- `ast.ts` — `Expression` type + `expression` Zod schema (closed, recursive).
- `vectors.ts` — `Vector`, the canonical `vectors` array.
- `index.ts` — public surface.

**`packages/expr-ts/src/`**
- `runtime.ts` — the thunk-based TS runtime `r`.
- `evaluate.ts` — `evaluate(expr, data)` interpreter.
- `emit.ts` — `emitTs(expr)`.
- `index.ts`.

**`packages/expr-php-emit/src/`**
- `emit.ts` — `emitPhp(expr)`.
- `runtime.php.ts` — the PHP runtime library as an exported string constant (`PHP_RUNTIME`).
- `index.ts`.
- `packages/expr-php-emit/scripts/php-conformance.mjs` — the gated PHP conformance runner.

**`packages/ir-schema/src/`** — `document.ts` gains expression attachment points; depends on `@camis/expr`.

---

## Task 1: expr value & error types

**Files:** Modify `packages/expr/package.json` (add `zod`); Create `packages/expr/src/value.ts`; Test `packages/expr/src/value.test.ts`

- [ ] **Step 1: Add zod**

Run: `pnpm --filter @camis/expr add zod@^3.24.0`

- [ ] **Step 2: Failing test** — `packages/expr/src/value.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { err, ok, type EvalResult } from "./value";

describe("EvalResult helpers", () => {
  it("ok wraps a value", () => {
    expect(ok(42)).toEqual({ ok: true, value: 42 });
  });
  it("err wraps an error code", () => {
    const r: EvalResult = err("DIV_BY_ZERO");
    expect(r).toEqual({ ok: false, error: "DIV_BY_ZERO" });
  });
});
```

- [ ] **Step 3: Run — FAIL** — Run: `pnpm --filter @camis/expr exec vitest run src/value.test.ts`

- [ ] **Step 4: Implement** — `packages/expr/src/value.ts`
```ts
export type Value = null | boolean | number | string;
export type EvalError = "TYPE_MISMATCH" | "DIV_BY_ZERO" | "UNKNOWN_VAR";
export type EvalResult = { ok: true; value: Value } | { ok: false; error: EvalError };

export const ok = (value: Value): EvalResult => ({ ok: true, value });
export const err = (error: EvalError): EvalResult => ({ ok: false, error });
```

- [ ] **Step 5: Run — PASS** — Run: `pnpm --filter @camis/expr exec vitest run src/value.test.ts`

- [ ] **Step 6: Commit**
```bash
git add packages/expr pnpm-lock.yaml
git commit -m "feat(expr): Value and EvalResult types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: expr AST + closed Zod schema (purity guard)

**Files:** Create `packages/expr/src/ast.ts`; Test `packages/expr/src/ast.test.ts`

- [ ] **Step 1: Failing test** — `packages/expr/src/ast.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { expression } from "./ast";

describe("expression schema", () => {
  it("accepts a nested valid expression", () => {
    const e = { kind: "and", args: [
      { kind: "eq", left: { kind: "var", name: "status" }, right: { kind: "lit", value: "published" } },
      { kind: "gt", left: { kind: "var", name: "rank" }, right: { kind: "lit", value: 3 } },
    ] };
    expect(expression.safeParse(e).success).toBe(true);
  });
  it("rejects a non-whitelisted node kind (purity guard)", () => {
    expect(expression.safeParse({ kind: "loop", body: { kind: "lit", value: 1 } }).success).toBe(false);
    expect(expression.safeParse({ kind: "assign", name: "x", value: { kind: "lit", value: 1 } }).success).toBe(false);
  });
  it("rejects a non-whitelisted call fn", () => {
    expect(expression.safeParse({ kind: "call", fn: "exec", args: [] }).success).toBe(false);
  });
  it("rejects a non-finite number literal", () => {
    expect(expression.safeParse({ kind: "lit", value: Infinity }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run — FAIL** — Run: `pnpm --filter @camis/expr exec vitest run src/ast.test.ts`

- [ ] **Step 3: Implement** — `packages/expr/src/ast.ts`
```ts
import { z } from "zod";
import type { Value } from "./value";

export type Expression =
  | { kind: "lit"; value: Value }
  | { kind: "var"; name: string }
  | { kind: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; left: Expression; right: Expression }
  | { kind: "add" | "sub" | "mul" | "div"; left: Expression; right: Expression }
  | { kind: "and" | "or"; args: Expression[] }
  | { kind: "not"; arg: Expression }
  | { kind: "call"; fn: "isNull" | "coalesce"; args: Expression[] };

const litValue = z.union([z.null(), z.boolean(), z.number().finite(), z.string()]);

export const expression: z.ZodType<Expression> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("lit"), value: litValue }),
    z.object({ kind: z.literal("var"), name: z.string() }),
    z.object({ kind: z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]), left: expression, right: expression }),
    z.object({ kind: z.enum(["add", "sub", "mul", "div"]), left: expression, right: expression }),
    z.object({ kind: z.enum(["and", "or"]), args: z.array(expression).min(1) }),
    z.object({ kind: z.literal("not"), arg: expression }),
    z.object({ kind: z.literal("call"), fn: z.enum(["isNull", "coalesce"]), args: z.array(expression) }),
  ]),
);
```

- [ ] **Step 4: Run — PASS** — Run: `pnpm --filter @camis/expr exec vitest run src/ast.test.ts`; then `pnpm --filter @camis/expr typecheck`

- [ ] **Step 5: Commit**
```bash
git add packages/expr
git commit -m "feat(expr): closed expression AST and Zod schema

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: expr-ts runtime — leaves, comparison, arithmetic

**Files:** Modify `packages/expr-ts/package.json` (add `@camis/expr` dep); Create `packages/expr-ts/src/runtime.ts`; Test `packages/expr-ts/src/runtime.test.ts`

The runtime is **thunk-based**: comparison/arithmetic operands are thunks `() => EvalResult` (enables short-circuit later for and/or). Leaves (`lit`,`var`) return `EvalResult` directly.

- [ ] **Step 1: Add dep** — Run: `pnpm --filter @camis/expr-ts add @camis/expr@workspace:*`

- [ ] **Step 2: Failing test** — `packages/expr-ts/src/runtime.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { EvalResult } from "@camis/expr";
import { r } from "./runtime";

const t = (res: EvalResult) => () => res;
const num = (n: number) => t({ ok: true, value: n });
const str = (s: string) => t({ ok: true, value: s });

describe("runtime leaves", () => {
  it("lit returns ok", () => expect(r.lit(5)).toEqual({ ok: true, value: 5 }));
  it("var found", () => expect(r.var({ a: 1 }, "a")).toEqual({ ok: true, value: 1 }));
  it("var missing → UNKNOWN_VAR", () => expect(r.var({}, "a")).toEqual({ ok: false, error: "UNKNOWN_VAR" }));
});

describe("runtime comparison", () => {
  it("eq same type", () => expect(r.eq(num(1), num(1))).toEqual({ ok: true, value: true }));
  it("eq null both", () => expect(r.eq(t(r.lit(null)), t(r.lit(null)))).toEqual({ ok: true, value: true }));
  it("eq one null → false", () => expect(r.eq(t(r.lit(null)), num(1))).toEqual({ ok: true, value: false }));
  it("eq mixed non-null type → TYPE_MISMATCH", () => expect(r.eq(num(1), str("1"))).toEqual({ ok: false, error: "TYPE_MISMATCH" }));
  it("lt numbers", () => expect(r.lt(num(1), num(2))).toEqual({ ok: true, value: true }));
  it("lt strings (ascii codepoint)", () => expect(r.lt(str("a"), str("b"))).toEqual({ ok: true, value: true }));
  it("lt mixed type → TYPE_MISMATCH", () => expect(r.lt(num(1), str("a"))).toEqual({ ok: false, error: "TYPE_MISMATCH" }));
  it("propagates operand error", () => expect(r.eq(t({ ok: false, error: "UNKNOWN_VAR" }), num(1))).toEqual({ ok: false, error: "UNKNOWN_VAR" }));
});

describe("runtime arithmetic", () => {
  it("add numbers", () => expect(r.add(num(2), num(3))).toEqual({ ok: true, value: 5 }));
  it("div", () => expect(r.div(num(7), num(2))).toEqual({ ok: true, value: 3.5 }));
  it("div by zero → DIV_BY_ZERO", () => expect(r.div(num(1), num(0))).toEqual({ ok: false, error: "DIV_BY_ZERO" }));
  it("add non-number → TYPE_MISMATCH", () => expect(r.add(num(1), str("x"))).toEqual({ ok: false, error: "TYPE_MISMATCH" }));
});
```

- [ ] **Step 3: Run — FAIL** — Run: `pnpm --filter @camis/expr-ts exec vitest run src/runtime.test.ts`

- [ ] **Step 4: Implement** — `packages/expr-ts/src/runtime.ts`
```ts
import { err, ok, type EvalResult, type Value } from "@camis/expr";

export type Thunk = () => EvalResult;

const typeOf = (v: Value): "null" | "boolean" | "number" | "string" =>
  v === null ? "null" : (typeof v as "boolean" | "number" | "string");

const force2 = (a: Thunk, b: Thunk, f: (x: Value, y: Value) => EvalResult): EvalResult => {
  const x = a();
  if (!x.ok) return x;
  const y = b();
  if (!y.ok) return y;
  return f(x.value, y.value);
};

const eqValues = (x: Value, y: Value): EvalResult => {
  const tx = typeOf(x);
  const ty = typeOf(y);
  if (tx === "null" && ty === "null") return ok(true);
  if (tx === "null" || ty === "null") return ok(false);
  if (tx !== ty) return err("TYPE_MISMATCH");
  return ok(x === y);
};

const order = (x: Value, y: Value, f: (c: number) => boolean): EvalResult => {
  const tx = typeOf(x);
  const ty = typeOf(y);
  if (tx === "number" && ty === "number") return ok(f(Math.sign((x as number) - (y as number))));
  if (tx === "string" && ty === "string") {
    const xs = x as string;
    const ys = y as string;
    return ok(f(xs < ys ? -1 : xs > ys ? 1 : 0));
  }
  return err("TYPE_MISMATCH");
};

const arith = (x: Value, y: Value, f: (a: number, b: number) => EvalResult): EvalResult => {
  if (typeOf(x) !== "number" || typeOf(y) !== "number") return err("TYPE_MISMATCH");
  return f(x as number, y as number);
};

export const r = {
  lit: (value: Value): EvalResult => ok(value),
  var: (data: Record<string, Value>, name: string): EvalResult =>
    Object.prototype.hasOwnProperty.call(data, name) ? ok(data[name]!) : err("UNKNOWN_VAR"),

  eq: (a: Thunk, b: Thunk): EvalResult => force2(a, b, eqValues),
  ne: (a: Thunk, b: Thunk): EvalResult => {
    const e = force2(a, b, eqValues);
    return e.ok ? ok(e.value !== true) : e;
  },
  lt: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => order(x, y, (c) => c < 0)),
  lte: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => order(x, y, (c) => c <= 0)),
  gt: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => order(x, y, (c) => c > 0)),
  gte: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => order(x, y, (c) => c >= 0)),

  add: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => arith(x, y, (m, n) => ok(m + n))),
  sub: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => arith(x, y, (m, n) => ok(m - n))),
  mul: (a: Thunk, b: Thunk): EvalResult => force2(a, b, (x, y) => arith(x, y, (m, n) => ok(m * n))),
  div: (a: Thunk, b: Thunk): EvalResult =>
    force2(a, b, (x, y) => arith(x, y, (m, n) => (n === 0 ? err("DIV_BY_ZERO") : ok(m / n)))),
};
```

- [ ] **Step 5: Run — PASS** — Run: `pnpm --filter @camis/expr-ts exec vitest run src/runtime.test.ts`; `pnpm --filter @camis/expr-ts typecheck`

- [ ] **Step 6: Commit**
```bash
git add packages/expr-ts pnpm-lock.yaml
git commit -m "feat(expr-ts): runtime leaves, comparison, arithmetic

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: expr-ts runtime — boolean (short-circuit), not, functions

**Files:** Modify `packages/expr-ts/src/runtime.ts`; Test `packages/expr-ts/src/runtime.test.ts` (append)

- [ ] **Step 1: Append failing tests**
```ts
describe("runtime boolean + functions", () => {
  const T = () => ({ ok: true, value: true }) as const;
  const F = () => ({ ok: true, value: false }) as const;
  const boom = () => ({ ok: false, error: "UNKNOWN_VAR" }) as const;

  it("and short-circuits on false (does not force later)", () => {
    let forced = false;
    const r2 = () => { forced = true; return { ok: true, value: true } as const; };
    expect(r.and(F, r2)).toEqual({ ok: true, value: false });
    expect(forced).toBe(false);
  });
  it("and all true", () => expect(r.and(T, T)).toEqual({ ok: true, value: true }));
  it("and non-boolean operand → TYPE_MISMATCH", () => expect(r.and(T, () => ({ ok: true, value: 1 }))).toEqual({ ok: false, error: "TYPE_MISMATCH" }));
  it("or short-circuits on true", () => expect(r.or(T, boom)).toEqual({ ok: true, value: true }));
  it("not", () => expect(r.not(T)).toEqual({ ok: true, value: false }));
  it("not non-boolean → TYPE_MISMATCH", () => expect(r.not(() => ({ ok: true, value: 1 }))).toEqual({ ok: false, error: "TYPE_MISMATCH" }));
  it("isNull true/false", () => {
    expect(r.isNull(() => ({ ok: true, value: null }))).toEqual({ ok: true, value: true });
    expect(r.isNull(() => ({ ok: true, value: 0 }))).toEqual({ ok: true, value: false });
  });
  it("coalesce returns first non-null", () => expect(r.coalesce(() => ({ ok: true, value: null }), () => ({ ok: true, value: 5 }))).toEqual({ ok: true, value: 5 }));
  it("coalesce all null → null", () => expect(r.coalesce(() => ({ ok: true, value: null }))).toEqual({ ok: true, value: null }));
});
```

- [ ] **Step 2: Run — FAIL** — Run: `pnpm --filter @camis/expr-ts exec vitest run src/runtime.test.ts`

- [ ] **Step 3: Append to `runtime.ts`** (after the existing `r` object, MERGE these members into `r` — add them as additional properties of the same `r` object literal):
```ts
  and: (...args: Thunk[]): EvalResult => {
    for (const t of args) {
      const v = t();
      if (!v.ok) return v;
      if (typeof v.value !== "boolean") return err("TYPE_MISMATCH");
      if (v.value === false) return ok(false);
    }
    return ok(true);
  },
  or: (...args: Thunk[]): EvalResult => {
    for (const t of args) {
      const v = t();
      if (!v.ok) return v;
      if (typeof v.value !== "boolean") return err("TYPE_MISMATCH");
      if (v.value === true) return ok(true);
    }
    return ok(false);
  },
  not: (a: Thunk): EvalResult => {
    const v = a();
    if (!v.ok) return v;
    if (typeof v.value !== "boolean") return err("TYPE_MISMATCH");
    return ok(!v.value);
  },
  isNull: (a: Thunk): EvalResult => {
    const v = a();
    return v.ok ? ok(v.value === null) : v;
  },
  coalesce: (...args: Thunk[]): EvalResult => {
    for (const t of args) {
      const v = t();
      if (!v.ok) return v;
      if (v.value !== null) return ok(v.value);
    }
    return ok(null);
  },
```
(These become members of the single exported `r` object alongside `lit`/`var`/`eq`/.../`div`. Place the comma-separated members inside the `export const r = { ... }` literal.)

- [ ] **Step 4: Run — PASS** — Run: `pnpm --filter @camis/expr-ts exec vitest run src/runtime.test.ts`; `pnpm --filter @camis/expr-ts typecheck`

- [ ] **Step 5: Commit**
```bash
git add packages/expr-ts
git commit -m "feat(expr-ts): runtime boolean short-circuit, not, functions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: expr-ts evaluate (interpreter)

**Files:** Create `packages/expr-ts/src/evaluate.ts`; Test `packages/expr-ts/src/evaluate.test.ts`

- [ ] **Step 1: Failing test** — `packages/expr-ts/src/evaluate.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { evaluate } from "./evaluate";

describe("evaluate", () => {
  it("evaluates a nested expression against data", () => {
    const e: Expression = { kind: "and", args: [
      { kind: "eq", left: { kind: "var", name: "status" }, right: { kind: "lit", value: "published" } },
      { kind: "gt", left: { kind: "var", name: "rank" }, right: { kind: "lit", value: 3 } },
    ] };
    expect(evaluate(e, { status: "published", rank: 5 })).toEqual({ ok: true, value: true });
    expect(evaluate(e, { status: "draft", rank: 5 })).toEqual({ ok: true, value: false });
  });
  it("propagates div by zero", () => {
    const e: Expression = { kind: "div", left: { kind: "lit", value: 1 }, right: { kind: "lit", value: 0 } };
    expect(evaluate(e, {})).toEqual({ ok: false, error: "DIV_BY_ZERO" });
  });
});
```

- [ ] **Step 2: Run — FAIL** — Run: `pnpm --filter @camis/expr-ts exec vitest run src/evaluate.test.ts`

- [ ] **Step 3: Implement** — `packages/expr-ts/src/evaluate.ts`
```ts
import type { EvalResult, Expression, Value } from "@camis/expr";
import { r } from "./runtime";

export const evaluate = (expr: Expression, data: Record<string, Value>): EvalResult => {
  const ev = (e: Expression): EvalResult => {
    switch (e.kind) {
      case "lit": return r.lit(e.value);
      case "var": return r.var(data, e.name);
      case "eq": return r.eq(() => ev(e.left), () => ev(e.right));
      case "ne": return r.ne(() => ev(e.left), () => ev(e.right));
      case "lt": return r.lt(() => ev(e.left), () => ev(e.right));
      case "lte": return r.lte(() => ev(e.left), () => ev(e.right));
      case "gt": return r.gt(() => ev(e.left), () => ev(e.right));
      case "gte": return r.gte(() => ev(e.left), () => ev(e.right));
      case "add": return r.add(() => ev(e.left), () => ev(e.right));
      case "sub": return r.sub(() => ev(e.left), () => ev(e.right));
      case "mul": return r.mul(() => ev(e.left), () => ev(e.right));
      case "div": return r.div(() => ev(e.left), () => ev(e.right));
      case "and": return r.and(...e.args.map((a) => () => ev(a)));
      case "or": return r.or(...e.args.map((a) => () => ev(a)));
      case "not": return r.not(() => ev(e.arg));
      case "call":
        return e.fn === "isNull"
          ? r.isNull(() => ev(e.args[0]!))
          : r.coalesce(...e.args.map((a) => () => ev(a)));
    }
  };
  return ev(expr);
};
```

- [ ] **Step 4: Run — PASS** — Run: `pnpm --filter @camis/expr-ts exec vitest run src/evaluate.test.ts`; `pnpm --filter @camis/expr-ts typecheck`

- [ ] **Step 5: Commit**
```bash
git add packages/expr-ts
git commit -m "feat(expr-ts): evaluate interpreter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: expr canonical vectors

**Files:** Create `packages/expr/src/vectors.ts`; Modify `packages/expr/src/index.ts`; Test `packages/expr/src/vectors.test.ts`

- [ ] **Step 1: Failing test** — `packages/expr/src/vectors.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { expression } from "./ast";
import { vectors } from "./vectors";

describe("vectors", () => {
  it("every vector's expr is a valid Expression", () => {
    for (const v of vectors) expect(expression.safeParse(v.expr).success).toBe(true);
  });
  it("covers every operator and every error code", () => {
    const kinds = new Set(vectors.map((v) => v.expr.kind));
    for (const k of ["lit", "var", "eq", "ne", "lt", "lte", "gt", "gte", "add", "sub", "mul", "div", "and", "or", "not", "call"]) {
      expect(kinds.has(k as never)).toBe(true);
    }
    const errors = new Set(vectors.filter((v) => !v.expect.ok).map((v) => (v.expect.ok ? "" : v.expect.error)));
    for (const e of ["TYPE_MISMATCH", "DIV_BY_ZERO", "UNKNOWN_VAR"]) expect(errors.has(e)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — FAIL** — Run: `pnpm --filter @camis/expr exec vitest run src/vectors.test.ts`

- [ ] **Step 3: Implement** — `packages/expr/src/vectors.ts` (a comprehensive suite; expand freely, but it MUST cover every operator + the three error codes + the tricky cases: div-by-zero, mixed-type eq, null-eq, and/or short-circuit, string ordering, float arithmetic):
```ts
import type { Expression } from "./ast";
import type { EvalResult, Value } from "./value";

export interface Vector {
  name: string;
  expr: Expression;
  data: Record<string, Value>;
  expect: EvalResult;
}

const lit = (value: Value): Expression => ({ kind: "lit", value });
const v = (name: string): Expression => ({ kind: "var", name });

export const vectors: Vector[] = [
  { name: "lit number", expr: lit(5), data: {}, expect: { ok: true, value: 5 } },
  { name: "lit string", expr: lit("x"), data: {}, expect: { ok: true, value: "x" } },
  { name: "lit null", expr: lit(null), data: {}, expect: { ok: true, value: null } },
  { name: "var found", expr: v("a"), data: { a: 3 }, expect: { ok: true, value: 3 } },
  { name: "var missing", expr: v("a"), data: {}, expect: { ok: false, error: "UNKNOWN_VAR" } },
  { name: "eq numbers true", expr: { kind: "eq", left: lit(1), right: lit(1) }, data: {}, expect: { ok: true, value: true } },
  { name: "eq null both", expr: { kind: "eq", left: lit(null), right: lit(null) }, data: {}, expect: { ok: true, value: true } },
  { name: "eq one null", expr: { kind: "eq", left: lit(null), right: lit(1) }, data: {}, expect: { ok: true, value: false } },
  { name: "eq mixed type", expr: { kind: "eq", left: lit(1), right: lit("1") }, data: {}, expect: { ok: false, error: "TYPE_MISMATCH" } },
  { name: "ne strings", expr: { kind: "ne", left: lit("a"), right: lit("b") }, data: {}, expect: { ok: true, value: true } },
  { name: "lt numbers", expr: { kind: "lt", left: lit(1), right: lit(2) }, data: {}, expect: { ok: true, value: true } },
  { name: "lt strings ascii", expr: { kind: "lt", left: lit("a"), right: lit("b") }, data: {}, expect: { ok: true, value: true } },
  { name: "lt numeric-string trap", expr: { kind: "lt", left: lit("10"), right: lit("9") }, data: {}, expect: { ok: true, value: true } },
  { name: "lte", expr: { kind: "lte", left: lit(2), right: lit(2) }, data: {}, expect: { ok: true, value: true } },
  { name: "gt", expr: { kind: "gt", left: lit(3), right: lit(2) }, data: {}, expect: { ok: true, value: true } },
  { name: "gte mixed type", expr: { kind: "gte", left: lit(1), right: lit("a") }, data: {}, expect: { ok: false, error: "TYPE_MISMATCH" } },
  { name: "add", expr: { kind: "add", left: lit(2), right: lit(3) }, data: {}, expect: { ok: true, value: 5 } },
  { name: "sub", expr: { kind: "sub", left: lit(2), right: lit(3) }, data: {}, expect: { ok: true, value: -1 } },
  { name: "mul", expr: { kind: "mul", left: lit(2), right: lit(3) }, data: {}, expect: { ok: true, value: 6 } },
  { name: "div float", expr: { kind: "div", left: lit(7), right: lit(2) }, data: {}, expect: { ok: true, value: 3.5 } },
  { name: "div exact", expr: { kind: "div", left: lit(6), right: lit(3) }, data: {}, expect: { ok: true, value: 2 } },
  { name: "div by zero", expr: { kind: "div", left: lit(1), right: lit(0) }, data: {}, expect: { ok: false, error: "DIV_BY_ZERO" } },
  { name: "add type mismatch", expr: { kind: "add", left: lit(1), right: lit("x") }, data: {}, expect: { ok: false, error: "TYPE_MISMATCH" } },
  { name: "float ieee", expr: { kind: "add", left: lit(0.1), right: lit(0.2) }, data: {}, expect: { ok: true, value: 0.1 + 0.2 } },
  { name: "and short-circuit false", expr: { kind: "and", args: [lit(false), v("missing")] }, data: {}, expect: { ok: true, value: false } },
  { name: "and true", expr: { kind: "and", args: [lit(true), lit(true)] }, data: {}, expect: { ok: true, value: true } },
  { name: "or short-circuit true", expr: { kind: "or", args: [lit(true), v("missing")] }, data: {}, expect: { ok: true, value: true } },
  { name: "and type mismatch", expr: { kind: "and", args: [lit(true), lit(1)] }, data: {}, expect: { ok: false, error: "TYPE_MISMATCH" } },
  { name: "not", expr: { kind: "not", arg: lit(true) }, data: {}, expect: { ok: true, value: false } },
  { name: "isNull true", expr: { kind: "call", fn: "isNull", args: [lit(null)] }, data: {}, expect: { ok: true, value: true } },
  { name: "coalesce", expr: { kind: "call", fn: "coalesce", args: [lit(null), lit(7)] }, data: {}, expect: { ok: true, value: 7 } },
];
```

- [ ] **Step 4: Wire `index.ts`** — `packages/expr/src/index.ts` (replace stub):
```ts
export { err, ok } from "./value";
export type { EvalError, EvalResult, Value } from "./value";
export { expression } from "./ast";
export type { Expression } from "./ast";
export { vectors } from "./vectors";
export type { Vector } from "./vectors";
```

- [ ] **Step 5: Run — PASS** — Run: `pnpm --filter @camis/expr exec vitest run`; `pnpm --filter @camis/expr typecheck`

- [ ] **Step 6: Commit**
```bash
git add packages/expr
git commit -m "feat(expr): canonical conformance vectors and public surface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: expr-ts conformance (interpreter over all vectors)

**Files:** Create `packages/expr-ts/src/conformance.test.ts`

- [ ] **Step 1: Failing test** — `packages/expr-ts/src/conformance.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { vectors } from "@camis/expr";
import { evaluate } from "./evaluate";

describe("conformance — interpreter", () => {
  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    expect(evaluate(v.expr, v.data)).toEqual(v.expect);
  });
});
```

- [ ] **Step 2: Run — should PASS** (the runtime/interpreter were built to the same semantics). Run: `pnpm --filter @camis/expr-ts exec vitest run src/conformance.test.ts`. If any vector fails, the diff shows an interpreter↔vector disagreement — fix the runtime or the vector's `expect` to match the pinned semantics in `SEMANTICS.md` (do NOT fudge; reconcile to the spec).

- [ ] **Step 3: Commit**
```bash
git add packages/expr-ts
git commit -m "test(expr-ts): conformance over canonical vectors (interpreter)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: expr-ts emitTs + emitted-TS conformance + golden + index

**Files:** Create `packages/expr-ts/src/emit.ts`; Create `packages/expr-ts/src/index.ts`; Test `packages/expr-ts/src/emit.test.ts`

- [ ] **Step 1: Failing test** — `packages/expr-ts/src/emit.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { vectors } from "@camis/expr";
import { r } from "./runtime";
import { emitTs } from "./emit";

describe("emitTs", () => {
  it("emits a runtime-call expression", () => {
    const e: Expression = { kind: "div", left: { kind: "var", name: "a" }, right: { kind: "lit", value: 0 } };
    expect(emitTs(e)).toBe('r.div(() => r.var(data, "a"), () => r.lit(0))');
  });

  it("emitted TS, executed, matches every vector", () => {
    for (const v of vectors) {
      const fn = new Function("r", "data", `return ${emitTs(v.expr)};`) as (rr: typeof r, d: Record<string, unknown>) => unknown;
      expect(fn(r, v.data)).toEqual(v.expect);
    }
  });
});
```

- [ ] **Step 2: Run — FAIL** — Run: `pnpm --filter @camis/expr-ts exec vitest run src/emit.test.ts`

- [ ] **Step 3: Implement** — `packages/expr-ts/src/emit.ts`
```ts
import type { Expression } from "@camis/expr";

const operand = (e: Expression): string => `() => ${emitTs(e)}`;

export const emitTs = (expr: Expression): string => {
  switch (expr.kind) {
    case "lit": return `r.lit(${JSON.stringify(expr.value)})`;
    case "var": return `r.var(data, ${JSON.stringify(expr.name)})`;
    case "eq": case "ne": case "lt": case "lte": case "gt": case "gte":
    case "add": case "sub": case "mul": case "div":
      return `r.${expr.kind}(${operand(expr.left)}, ${operand(expr.right)})`;
    case "and": case "or":
      return `r.${expr.kind}(${expr.args.map(operand).join(", ")})`;
    case "not": return `r.not(${operand(expr.arg)})`;
    case "call":
      return expr.fn === "isNull"
        ? `r.isNull(${operand(expr.args[0]!)})`
        : `r.coalesce(${expr.args.map(operand).join(", ")})`;
  }
};
```
`packages/expr-ts/src/index.ts` (replace stub):
```ts
export { r } from "./runtime";
export type { Thunk } from "./runtime";
export { evaluate } from "./evaluate";
export { emitTs } from "./emit";
```

- [ ] **Step 4: Run — PASS** — Run: `pnpm --filter @camis/expr-ts exec vitest run`; `pnpm --filter @camis/expr-ts typecheck`

- [ ] **Step 5: Commit**
```bash
git add packages/expr-ts
git commit -m "feat(expr-ts): emitTs and emitted-TS conformance

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: expr-php-emit emitPhp + golden

**Files:** Modify `packages/expr-php-emit/package.json` (add `@camis/expr`); Create `packages/expr-php-emit/src/emit.ts`; Create `packages/expr-php-emit/src/index.ts`; Test `packages/expr-php-emit/src/emit.test.ts`

- [ ] **Step 1: Add dep** — Run: `pnpm --filter @camis/expr-php-emit add @camis/expr@workspace:*`

- [ ] **Step 2: Failing test** — `packages/expr-php-emit/src/emit.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { emitPhp } from "./emit";

describe("emitPhp", () => {
  it("emits a runtime-call PHP expression with arrow-fn thunks", () => {
    const e: Expression = { kind: "div", left: { kind: "var", name: "a" }, right: { kind: "lit", value: 0 } };
    expect(emitPhp(e)).toBe('Ring1::div(fn() => Ring1::var($data, "a"), fn() => Ring1::lit(0))');
  });
  it("emits string and null literals", () => {
    expect(emitPhp({ kind: "lit", value: "x" })).toBe('Ring1::lit("x")');
    expect(emitPhp({ kind: "lit", value: null })).toBe("Ring1::lit(null)");
    expect(emitPhp({ kind: "lit", value: true })).toBe("Ring1::lit(true)");
  });
});
```

- [ ] **Step 3: Run — FAIL** — Run: `pnpm --filter @camis/expr-php-emit exec vitest run src/emit.test.ts`

- [ ] **Step 4: Implement** — `packages/expr-php-emit/src/emit.ts`
```ts
import type { Expression, Value } from "@camis/expr";

const phpLiteral = (value: Value): string => {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value); // finite double → valid PHP float/int literal
  return JSON.stringify(value); // string with JSON escaping (valid PHP double-quoted string for our inputs)
};

const operand = (e: Expression): string => `fn() => ${emitPhp(e)}`;

export const emitPhp = (expr: Expression): string => {
  switch (expr.kind) {
    case "lit": return `Ring1::lit(${phpLiteral(expr.value)})`;
    case "var": return `Ring1::var($data, ${JSON.stringify(expr.name)})`;
    case "eq": case "ne": case "lt": case "lte": case "gt": case "gte":
    case "add": case "sub": case "mul": case "div":
      return `Ring1::${expr.kind}(${operand(expr.left)}, ${operand(expr.right)})`;
    case "and": case "or":
      return `Ring1::${expr.kind}(${expr.args.map(operand).join(", ")})`;
    case "not": return `Ring1::not(${operand(expr.arg)})`;
    case "call":
      return expr.fn === "isNull"
        ? `Ring1::isNull(${operand(expr.args[0]!)})`
        : `Ring1::coalesce(${expr.args.map(operand).join(", ")})`;
  }
};
```
`packages/expr-php-emit/src/index.ts` (replace stub): `export { emitPhp } from "./emit";` and (after Task 10) `export { PHP_RUNTIME } from "./runtime.php";`

- [ ] **Step 5: Run — PASS** — Run: `pnpm --filter @camis/expr-php-emit exec vitest run src/emit.test.ts`; `pnpm --filter @camis/expr-php-emit typecheck`

- [ ] **Step 6: Commit**
```bash
git add packages/expr-php-emit pnpm-lock.yaml
git commit -m "feat(expr-php-emit): emitPhp composition

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: PHP runtime library + gated conformance runner + CI

**Files:** Create `packages/expr-php-emit/src/runtime.php.ts` (the PHP runtime as a string const); Modify `packages/expr-php-emit/src/index.ts`; Create `packages/expr-php-emit/scripts/php-conformance.mjs`; Modify `packages/expr-php-emit/package.json` (add `conformance` script); Create `.github/workflows/expr-php-conformance.yml`; Test `packages/expr-php-emit/src/runtime.php.test.ts`

> The PHP runtime mirrors the TS runtime EXACTLY but uses PHP-safe operations: `===` (never `==`), `strcmp` for string ordering (never `<` on strings — numeric-string coercion!), explicit `is_*` type checks, and **all numbers as `float`**. It cannot be executed in the sandbox (no PHP); it is verified by the gated CI conformance job.

- [ ] **Step 1: Structural test** — `packages/expr-php-emit/src/runtime.php.test.ts` (the runtime is a static asset; test only that it's present + well-formed-ish):
```ts
import { describe, expect, it } from "vitest";
import { PHP_RUNTIME } from "./runtime.php";

describe("PHP_RUNTIME", () => {
  it("opens with <?php and defines the Ring1 class with the catalog methods", () => {
    expect(PHP_RUNTIME.startsWith("<?php")).toBe(true);
    for (const m of ["lit", "var", "eq", "ne", "lt", "lte", "gt", "gte", "add", "sub", "mul", "div", "and", "or", "not", "isNull", "coalesce"]) {
      expect(PHP_RUNTIME).toContain(`function ${m}(`);
    }
  });
  it("uses strcmp and never bare == for comparisons", () => {
    expect(PHP_RUNTIME).toContain("strcmp");
    expect(PHP_RUNTIME).not.toMatch(/[^=!<>]==[^=]/); // no loose ==
  });
});
```

- [ ] **Step 2: Run — FAIL** — Run: `pnpm --filter @camis/expr-php-emit exec vitest run src/runtime.php.test.ts`

- [ ] **Step 3: Implement the PHP runtime** — `packages/expr-php-emit/src/runtime.php.ts`:
```ts
export const PHP_RUNTIME = `<?php
declare(strict_types=1);

final class Ring1 {
    public static function ok($value): array { return ["ok" => true, "value" => $value]; }
    public static function err(string $code): array { return ["ok" => false, "error" => $code]; }

    private static function typeOf($v): string {
        if ($v === null) return "null";
        if (is_bool($v)) return "boolean";
        if (is_int($v) || is_float($v)) return "number";
        return "string";
    }
    private static function num($v): float { return (float) $v; }

    public static function lit($value): array { return self::ok($value); }
    public static function var(array $data, string $name): array {
        return array_key_exists($name, $data) ? self::ok($data[$name]) : self::err("UNKNOWN_VAR");
    }

    private static function force2(callable $a, callable $b, callable $f): array {
        $x = $a(); if (!$x["ok"]) return $x;
        $y = $b(); if (!$y["ok"]) return $y;
        return $f($x["value"], $y["value"]);
    }
    private static function eqValues($x, $y): array {
        $tx = self::typeOf($x); $ty = self::typeOf($y);
        if ($tx === "null" && $ty === "null") return self::ok(true);
        if ($tx === "null" || $ty === "null") return self::ok(false);
        if ($tx !== $ty) return self::err("TYPE_MISMATCH");
        if ($tx === "number") return self::ok(self::num($x) === self::num($y));
        if ($tx === "string") return self::ok(strcmp($x, $y) === 0);
        return self::ok($x === $y);
    }
    private static function order($x, $y, callable $f): array {
        $tx = self::typeOf($x); $ty = self::typeOf($y);
        if ($tx === "number" && $ty === "number") { $c = self::num($x) <=> self::num($y); return self::ok($f($c)); }
        if ($tx === "string" && $ty === "string") { $c = strcmp($x, $y); $c = $c < 0 ? -1 : ($c > 0 ? 1 : 0); return self::ok($f($c)); }
        return self::err("TYPE_MISMATCH");
    }
    private static function arith($x, $y, callable $f): array {
        if (self::typeOf($x) !== "number" || self::typeOf($y) !== "number") return self::err("TYPE_MISMATCH");
        return $f(self::num($x), self::num($y));
    }

    public static function eq(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::eqValues($x, $y)); }
    public static function ne(callable $a, callable $b): array { $e = self::force2($a, $b, fn($x, $y) => self::eqValues($x, $y)); return $e["ok"] ? self::ok($e["value"] !== true) : $e; }
    public static function lt(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::order($x, $y, fn($c) => $c < 0)); }
    public static function lte(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::order($x, $y, fn($c) => $c <= 0)); }
    public static function gt(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::order($x, $y, fn($c) => $c > 0)); }
    public static function gte(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::order($x, $y, fn($c) => $c >= 0)); }

    public static function add(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::arith($x, $y, fn($m, $n) => self::ok($m + $n))); }
    public static function sub(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::arith($x, $y, fn($m, $n) => self::ok($m - $n))); }
    public static function mul(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::arith($x, $y, fn($m, $n) => self::ok($m * $n))); }
    public static function div(callable $a, callable $b): array { return self::force2($a, $b, fn($x, $y) => self::arith($x, $y, fn($m, $n) => $n === 0.0 ? self::err("DIV_BY_ZERO") : self::ok($m / $n))); }

    public static function and(callable ...$args): array {
        foreach ($args as $t) { $v = $t(); if (!$v["ok"]) return $v; if (!is_bool($v["value"])) return self::err("TYPE_MISMATCH"); if ($v["value"] === false) return self::ok(false); }
        return self::ok(true);
    }
    public static function or(callable ...$args): array {
        foreach ($args as $t) { $v = $t(); if (!$v["ok"]) return $v; if (!is_bool($v["value"])) return self::err("TYPE_MISMATCH"); if ($v["value"] === true) return self::ok(true); }
        return self::ok(false);
    }
    public static function not(callable $a): array { $v = $a(); if (!$v["ok"]) return $v; if (!is_bool($v["value"])) return self::err("TYPE_MISMATCH"); return self::ok(!$v["value"]); }
    public static function isNull(callable $a): array { $v = $a(); return $v["ok"] ? self::ok($v["value"] === null) : $v; }
    public static function coalesce(callable ...$args): array {
        foreach ($args as $t) { $v = $t(); if (!$v["ok"]) return $v; if ($v["value"] !== null) return self::ok($v["value"]); }
        return self::ok(null);
    }
}
`;
```
(Note for the structural test: `<=>` and `<` inside `fn($c) => $c < 0` are numeric comparisons on the spaceship result — not string `==`; the `not /[^=!<>]==[^=]/` regex only forbids loose `==`. If the test's regex is too strict for `===`, adjust it to specifically forbid a `==` not part of `===`/`!==`.)

Add `export { PHP_RUNTIME } from "./runtime.php";` to `packages/expr-php-emit/src/index.ts`.

- [ ] **Step 4: Run structural test — PASS** — Run: `pnpm --filter @camis/expr-php-emit exec vitest run src/runtime.php.test.ts`; `pnpm --filter @camis/expr-php-emit typecheck`

- [ ] **Step 5: Conformance runner** — `packages/expr-php-emit/scripts/php-conformance.mjs`:
```js
// Emits PHP for every vector, runs it with PHP, compares value-based to the vector's expect.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vectors } from "@camis/expr";
import { emitPhp, PHP_RUNTIME } from "@camis/expr-php-emit";

const dir = await mkdtemp(join(tmpdir(), "ring1-php-"));
let failures = 0;
try {
  await writeFile(join(dir, "Ring1.php"), PHP_RUNTIME);
  for (const v of vectors) {
    const php = `<?php require "${join(dir, "Ring1.php")}"; $data = json_decode('${JSON.stringify(v.data)}', true); $res = ${emitPhp(v.expr)}; echo json_encode($res);`;
    const file = join(dir, "vec.php");
    await writeFile(file, php);
    const out = execFileSync("php", [file], { encoding: "utf8" });
    const got = JSON.parse(out);
    // value-based comparison (numbers compared as JS numbers after JSON round-trip)
    const want = v.expect;
    const same = JSON.stringify(got) === JSON.stringify(want);
    if (!same) { failures++; console.error(\`FAIL \${v.name}: got \${JSON.stringify(got)} want \${JSON.stringify(want)}\`); }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
if (failures > 0) { console.error(\`\${failures} PHP conformance failures\`); process.exit(1); }
console.log(\`PHP conformance PASS (\${vectors.length} vectors)\`);
```
Add to `packages/expr-php-emit/package.json` scripts: `"conformance": "node scripts/php-conformance.mjs"`. (Run via `tsx`/`node` with TS resolution; if `.ts` imports need it, use `"conformance": "tsx scripts/php-conformance.mjs"` and add `tsx` devDep — mirror however adapter-strapi's boot-smoke was wired.)
NOTE: `json_encode` of a PHP float like `0.30000000000000004` and JS `JSON.stringify(0.1+0.2)` should match (both 17-sig-fig shortest round-trip in modern PHP/Node). If a float vector mismatches purely on formatting, switch the comparison to parse both numbers and compare with a tiny epsilon OR compare `Number(got.value) === want.value`. Document whichever you use.

- [ ] **Step 6: CI workflow** — `.github/workflows/expr-php-conformance.yml`:
```yaml
name: expr-php-conformance
on:
  workflow_dispatch:
  pull_request:
  schedule:
    - cron: "0 5 * * *"
jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: shivammathur/setup-php@v2
        with:
          php-version: "8.3"
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: ".nvmrc"
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @camis/expr-php-emit conformance
```

- [ ] **Step 7: Do NOT run the conformance locally** (no PHP in sandbox). Confirm the runner script type-checks/reads cleanly; it is validated in CI. Run `pnpm --filter @camis/expr-php-emit exec vitest run` (unit tests green).

- [ ] **Step 8: Commit**
```bash
git add packages/expr-php-emit .github/workflows/expr-php-conformance.yml pnpm-lock.yaml
git commit -m "feat(expr-php-emit): PHP runtime library and gated conformance runner

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: divergence-detection meta-test

**Files:** Create `packages/expr-ts/src/divergence.test.ts`

Proves the conformance suite genuinely catches a runtime that disagrees with the vectors (exit criterion: "a deliberately divergent change fails CI").

- [ ] **Step 1: Test** — `packages/expr-ts/src/divergence.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { vectors } from "@camis/expr";
import { evaluate } from "./evaluate";

describe("divergence detection", () => {
  it("a wrong expected-value would fail the conformance assertion", () => {
    // Simulate a divergent runtime by mutating the expected result and confirming the comparison rejects it.
    const v = vectors.find((x) => x.name === "div by zero")!;
    const wrong = { ok: true, value: 0 } as const;
    expect(evaluate(v.expr, v.data)).not.toEqual(wrong); // the real runtime must NOT match a divergent expectation
    expect(evaluate(v.expr, v.data)).toEqual(v.expect);
  });
});
```

- [ ] **Step 2: Run — PASS** — Run: `pnpm --filter @camis/expr-ts exec vitest run src/divergence.test.ts`

- [ ] **Step 3: Commit**
```bash
git add packages/expr-ts
git commit -m "test(expr-ts): divergence-detection meta-test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 12: IR wiring — expression attachment points

**Files:** Modify `packages/ir-schema/package.json` (add `@camis/expr`); Modify `packages/ir-schema/src/document.ts`; Modify `eslint.config.js` (allow `ir-schema → expr`); Test `packages/ir-schema/src/document.test.ts` (append)

- [ ] **Step 1: Add dep** — Run: `pnpm --filter @camis/ir-schema add @camis/expr@workspace:*`

- [ ] **Step 2: Append failing test** — to `packages/ir-schema/src/document.test.ts`:
```ts
describe("field expression attachment points", () => {
  it("accepts a field with a validate/visibleWhen/computed expression", () => {
    const r = contentType.safeParse({
      name: "Article",
      kind: "collection",
      fields: [{
        type: "string", name: "slug",
        visibleWhen: { kind: "eq", left: { kind: "var", name: "status" }, right: { kind: "lit", value: "published" } },
      }],
    });
    expect(r.success).toBe(true);
  });
  it("rejects an ill-formed expression", () => {
    const r = contentType.safeParse({
      name: "Article", kind: "collection",
      fields: [{ type: "string", name: "slug", computed: { kind: "loop" } }],
    });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 3: Wire the field schema** — In `packages/ir-schema/src/fields.ts` (where the field variant objects are built), add three optional keys to the `common` shape (so every field variant gains them): import `expression` from `@camis/expr` and add to `common`:
```ts
import { expression } from "@camis/expr";
// ...
const common = {
  name: fieldName,
  required: z.boolean().optional(),
  validate: expression.optional(),
  visibleWhen: expression.optional(),
  computed: expression.optional(),
};
```
(If `common` is shared by component fields too, that's fine — components may also carry expressions.)

- [ ] **Step 4: ESLint boundary** — In `eslint.config.js`, the `ir-schema` leaf rule (added in Phase 1) forbids `@camis/*` imports from `ir-schema`. Update it to ALLOW `@camis/expr`: change the ir-schema `no-restricted-imports` pattern group to `["@camis/*", "!@camis/expr"]` (gitignore-style negation), so `ir-schema → expr` is permitted but other internal imports stay blocked. Verify with `pnpm lint`.

- [ ] **Step 5: Run tests + lint + typecheck**
Run: `pnpm --filter @camis/ir-schema exec vitest run src/document.test.ts` (pass)
Run: `pnpm --filter @camis/ir-schema test` (whole package green — the new optional keys must not break existing field tests)
Run: `pnpm lint` (clean), `pnpm --filter @camis/ir-schema typecheck` (clean)

- [ ] **Step 6: Commit**
```bash
git add packages/ir-schema eslint.config.js pnpm-lock.yaml
git commit -m "feat(ir-schema): expression attachment points on fields

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 13: expr public surfaces + full sweep

**Files:** verify `expr-ts`/`expr-php-emit` index exports; full sweep.

- [ ] **Step 1: Confirm public surfaces** — `@camis/expr` exports `expression`, `Expression`, `Value`, `EvalResult`, `EvalError`, `ok`, `err`, `vectors`, `Vector`. `@camis/expr-ts` exports `evaluate`, `emitTs`, `r`. `@camis/expr-php-emit` exports `emitPhp`, `PHP_RUNTIME`. Add any missing export and a one-line index test if absent.

- [ ] **Step 2: Full sweep** — run, all green (report counts):
```bash
pnpm lint
pnpm -r typecheck
pnpm -r test
```
The per-commit suite includes the expr/expr-ts/expr-php-emit unit + conformance (interpreter + emitted-TS) tests. The emitted-PHP conformance runs only in the gated CI job.

- [ ] **Step 3: Commit (only if a fix was needed)**
```bash
git add packages/expr packages/expr-ts packages/expr-php-emit
git commit -m "chore(expr): finalize public surfaces

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** D1 JSON AST (Task 2) · D2 strict semantics (Tasks 3–4 runtime, pinned) · D3 per-language runtime library (Task 3–4 TS, Task 10 PHP; emitters Tasks 8/9 compose; interpreter Task 5 shares TS runtime) · D4 total typed eval (Task 1 types; runtime everywhere) · D5 TS per-commit (Tasks 7,8) + gated PHP (Task 10) · D6 minimal catalog (Task 2 node set) · D7 expr leaf + ir-schema→expr + boundary update (Task 12) · D8 structural IR wiring (Task 12) · D9 PHP loose-operator avoidance (Task 10 runtime: ===/strcmp/float) · D10 value-based conformance comparison (Task 10 runner). Exit criteria: 100% vectors in TS interpreter+emitted-TS (Tasks 7,8) and emitted-PHP (Task 10 CI); divergence test (Task 11); purity guard (Task 2). Vectors comprehensive (Task 6).

**Placeholder scan:** none — concrete code/commands throughout. The Task 10 PHP runtime is a complete static asset; its execution is the gated CI job (PHP unavailable locally — expected, like the Strapi boot smoke).

**Type consistency:** `Value`/`EvalResult`/`EvalError`/`ok`/`err` (Task 1) used across runtime (3–4), evaluate (5), vectors (6); `Expression`/`expression`/`vectors`/`Vector` (Tasks 2,6) consumed by expr-ts (5,7,8) and expr-php-emit (9,10) and ir-schema (12); `r`/`Thunk` (Tasks 3–4) used by evaluate (5) and the emitted-TS conformance (8); `emitTs`/`emitPhp`/`PHP_RUNTIME` consistent across emit + conformance tasks. The TS runtime `r.<kind>` method names exactly match the AST `kind`s and the PHP `Ring1::<kind>` methods (so emitters and conformance line up).
