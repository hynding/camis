# Phase 4 — Ring 1 Expression Layer Design (`expr`, `expr-ts`, `expr-php-emit`)

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 4
**Scope:** one bounded, pure, total expression grammar with semantics pinned so that the same
`(expression, data)` yields the **same** result in TypeScript and in emitted PHP, locked by a
canonical cross-runtime conformance vector suite. Wire expressions into the IR as declarative
attachment points (no target wiring yet).

---

## 1. Context & goal

Ring 1 is the project's second spine (after the IR). Its entire value is the guarantee that one
expression produces identical results in PHP and TS. The conformance vector suite is the
load-bearing test investment (ARCHITECTURE §5.1). Phase 4 builds the machinery end-to-end with a
**minimal-but-complete catalog** that exercises every category; breadth is added later against the
same machinery.

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **JSON discriminated-union AST**, Zod-validated like the IR. No parser/lexer. | We own the grammar; serializes natively into the IR; no cross-runtime parser to keep in sync. |
| D2 | **Strict, no implicit coercion.** Single numeric type (IEEE-754 double); conditions must be boolean; null explicit; per-operator semantics pinned in a written spec. | Makes TS≡PHP tractable; avoids the JSONLogic coercion/truthiness/null divergence class. |
| D3 | **Per-language runtime library.** Each language has a small library (`r.eq/r.div/...`) encoding the semantics once; emitters compose calls to it; the TS interpreter walks the AST calling the same TS runtime. | Centralizes the hard semantics in two small, conformance-tested libraries instead of N emitter templates; the interpreter and emitted-TS can't diverge from each other. |
| D4 | **Total typed evaluation.** Every `(expr, data)` → a `Value` or a closed `EvalError` (`TYPE_MISMATCH`/`DIV_BY_ZERO`/`UNKNOWN_VAR`). No exceptions, no NaN/Infinity/undefined escaping. | Determinism + cross-runtime identity; predictable error surface. |
| D5 | **TS conformance per-commit; emitted-PHP conformance in a gated CI job (PHP installed).** | The PHP emitter builds/unit-tests without PHP; only executing emitted PHP needs a runtime (sandbox blocks PHP). Matches PLAN + Phase 2 gated-smoke pattern. |
| D6 | **Minimal core catalog** (literals, `var`, comparison, boolean, arithmetic, `isNull`/`coalesce`). | Phase 4's priority is the cross-runtime machinery, not catalog breadth. |
| D7 | **AST lives in `expr`; `ir-schema` depends on `expr`** for the `Expression` type. `expr` becomes the leaf. | Single source of the grammar; DRY across ir-schema/expr-ts/expr-php-emit. (Update the ESLint boundary rule to allow `ir-schema → expr`.) |
| D8 | **IR wiring is structural only.** Add optional `validate?`/`visibleWhen?`/`computed?` Expressions to `Field`, Zod-validated; adapters don't consume them; semantic validation (var-resolution, type-checking against field types) deferred. | Keeps Phase 4 focused on the conformance spine. |
| D9 | **PHP runtime/emitter avoid PHP loose operators entirely** (`===`/`strcmp`/`is_*`; all numbers as PHP `float`). | PHP `==`/`<` do numeric-string coercion and type juggling — the biggest divergence trap. |
| D10 | **Conformance comparison is value-based**, not string-based (parse both sides' canonical output, compare structurally; numbers by exact double equality). | PHP `json_encode` and JS `JSON.stringify` format floats differently; comparing values avoids false divergence. |

## 3. Value & error model

- **Values:** `null | boolean | number (IEEE-754 double) | string`. Integer literals are doubles. No lists yet.
- **`EvalError`** (closed): `"TYPE_MISMATCH" | "DIV_BY_ZERO" | "UNKNOWN_VAR"`.
- **`EvalResult` = `{ ok: true; value: Value } | { ok: false; error: EvalError }`.**
- Evaluation is **total**: every input yields one of the above; both runtimes produce the same value or the same error code.
- `data` is a flat map of `string → Value`.

## 4. AST node set (discriminated union on `kind`; Zod, recursive via `z.lazy`)

- `{ kind:"lit", value: null | boolean | number(finite) | string }` — number literals must be **finite** (no NaN/Infinity).
- `{ kind:"var", name: string }`
- comparison: `{ kind:"eq"|"ne"|"lt"|"lte"|"gt"|"gte", left: Expression, right: Expression }`
- boolean: `{ kind:"and"|"or", args: Expression[] (≥1) }` · `{ kind:"not", arg: Expression }`
- arithmetic: `{ kind:"add"|"sub"|"mul"|"div", left: Expression, right: Expression }`
- functions: `{ kind:"call", fn:"isNull"|"coalesce", args: Expression[] }` (`isNull` arity 1; `coalesce` ≥1)

The Zod schema is **closed**: a node whose `kind` (or `call.fn`) is not in this set is rejected. That closedness **is** the purity/totality guard (§7).

## 5. Pinned semantics (the full per-operator table lives in `expr/SEMANTICS.md`; representative rules)

- **`eq`/`ne`:** both `null` → equal; exactly one `null` → not-equal; same non-null type → value equality (number by IEEE double value, string by codepoint, boolean by value); **different non-null types → `TYPE_MISMATCH`**.
- **`lt`/`lte`/`gt`/`gte`:** defined on (number,number) and (string,string); string ordering is **codepoint/byte order over ASCII** (PHP uses `strcmp`; non-ASCII ordering out of scope this phase); other operand types → `TYPE_MISMATCH`.
- **`and`/`or`:** boolean operands; **short-circuit left→right** (`and(false, x)=false` without evaluating `x`); a needed non-boolean operand → `TYPE_MISMATCH`.
- **`not`:** boolean → negate; else `TYPE_MISMATCH`.
- **`add`/`sub`/`mul`:** numbers → IEEE-754 double arithmetic (identical in JS and PHP `float`); non-number → `TYPE_MISMATCH`.
- **`div`:** divisor `0` → **`DIV_BY_ZERO`** (explicitly guarded; never JS `Infinity`/PHP error); else float division.
- **`var`:** `name` in data → its value (may be `null`); absent → `UNKNOWN_VAR`.
- **`isNull(x)`** → boolean (total). **`coalesce(a,b,…)`** → first non-null (left→right; an error encountered before a non-null propagates).

## 6. Packages & dependency direction

- **`expr`** (leaf; dep `zod`): `Expression` AST + Zod schema (`expression`); `Value`/`EvalResult`/`EvalError` types; `SEMANTICS.md` (written spec); the **canonical conformance vectors** (`vectors.ts` → `Vector[] = { name: string; expr: Expression; data: Record<string,Value>; expect: EvalResult }`).
- **`expr-ts`** (dep `expr`): the **TS runtime library** (`r.eq/r.div/...` over `EvalResult`); `evaluate(expr, data): EvalResult` (interpreter = AST walk calling the runtime); `emitTs(expr): string` (emits a TS expression referencing `r` and `data`).
- **`expr-php-emit`** (dep `expr`): the **PHP runtime library** (a `.php` source asset encoding the semantics with `===`/`strcmp`/float casts); `emitPhp(expr): string` (emits a PHP expression referencing the runtime + `$data`).
- **`ir-schema`** gains a dep on **`expr`** for the `Expression` type (§8). Update the ESLint boundary rule: `ir-schema → expr` allowed; `expr` imports nothing internal.

## 7. Exit-criteria mechanisms (from PLAN.md Phase 4)

- **100% of vectors pass** in: the TS interpreter (per-commit), the executed emitted-TS (per-commit), and the executed emitted-PHP (gated CI). The interpreter and emitted-TS share the TS runtime, so the **load-bearing identity check is TS-runtime ≡ PHP-runtime** (the CI job); the emitted-TS check proves the emitter composes runnable code.
- **A deliberately divergent change to one runtime fails CI:** a test perturbs one runtime (e.g. wrong `div`-by-zero handling) and the conformance suite goes red — proving it genuinely cross-checks the runtimes.
- **Purity/totality guard:** a test feeds a non-whitelisted node (`{kind:"loop"}`, `{kind:"assign"}`, a non-catalog `call.fn`) and asserts the Zod schema **rejects** it.

## 8. Conformance harness

- **Per-commit (`expr-ts`):** every vector → `evaluate(v.expr, v.data)` equals `v.expect`; AND emit TS, execute via `new Function("r","data","return "+emitted)` with the runtime, compare to `v.expect`.
- **Per-commit (`expr-php-emit`):** `emitPhp` golden tests for representative nodes (emitted **string**, byte-exact, no PHP needed).
- **Gated CI job (PHP):** a runner emits PHP for every vector, wraps it with the PHP runtime + `$data`, executes via `php`, prints a canonical per-vector result line; the comparison **parses** each line and compares structurally to `v.expect` (numbers by exact double equality) — value-based, not string-based (D10). Triggered on `workflow_dispatch` + per-PR (PHP is cheap to install in Actions, unlike the Strapi boot smoke; decide cadence in the plan — at minimum gated + nightly).

## 9. IR wiring (declarative only)

- `ir-schema` adds optional `validate?: Expression`, `visibleWhen?: Expression`, `computed?: Expression` to `Field`, validated structurally by Zod (via `expr`'s schema). **Adapters do not consume them** (Phase 5+). Semantic validation deferred (D8).

## 10. Testing

- **`expr`:** Zod accept/reject incl. the closedness guard and finite-literal guard; the vectors are data (type-checked).
- **`expr-ts`:** full conformance (interpreter + emitted-TS) over **all** vectors; the vector suite covers every operator, every error code, and the tricky cross-runtime cases (div-by-zero, mixed-type eq, null-eq, and/or short-circuit, string ordering, float arithmetic); `emitTs` golden for representative nodes.
- **`expr-php-emit`:** `emitPhp` golden for representative nodes; the gated PHP conformance runner.
- **`ir-schema`:** a field carrying a `validate` expression validates; an ill-formed expression is rejected.

## 11. Cross-cutting

- Ring 1 is closed and total — no loops, assignment, side effects, or host calls (enforced by the closed grammar). Reviewers reject any Ring-1 addition that breaches purity/totality.
- Determinism: pure runtimes, value-based conformance comparison, golden emitter strings.
- The vectors in `expr` are the single canonical contract; both runtimes implement against them.

## 12. Exit criteria (from PLAN.md Phase 4)

- 100% of conformance vectors pass in both the TS evaluator and the emitted PHP.
- A deliberately divergent change to one runtime fails CI.
- The purity/totality guard rejects a loop/side-effect test case.
- `pnpm -r typecheck` / `pnpm -r test` / `pnpm lint` green; per-commit CI green; the gated PHP conformance job green.
