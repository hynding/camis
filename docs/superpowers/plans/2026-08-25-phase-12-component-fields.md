# Phase 12 — Component Fields on Relational Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `component` fields generate real relational structure on the Filament and Express targets instead of downgrade gaps: non-repeatable components become prefixed embedded columns; repeatable components become child tables with FKs, relations, and (Filament) `Repeater` forms.

**Architecture:** A target-neutral expansion utility in `adapter-kernel` (`expandComponents`) walks a content type's component tree against `doc.components` and returns (a) embedded scalars with column paths and (b) repeatable child tables with their own scalar sets — plus downgrade gaps for the bounded-out cases (relation/ai inside a component, repeatable nested inside a repeatable, unknown depth ≥ safety). Each adapter maps that neutral expansion onto its own emitters. Strapi is untouched (native components).

**Tech Stack:** TypeScript strict, Vitest goldens (byte-exact), no new deps.

**Spec:** Measured OYL gap report (Phase 11 exit): exactly six `component` gaps per target — `Transaction.amount`, `Budget.limit` (`finance.money`), `Consumable.facts`, `ConsumableProduct.facts` (`nutrition.nutrition-facts`, which nests a non-repeatable `servingSize` and a repeatable `additional`), `Consumption.nutrients`, `ActivitySession.quantities` (repeatable `activity.quantity`).

## Global Constraints

- Existing golden files must remain byte-identical (no existing fixture uses components on these targets — the blog fixtures' `seo` component currently gaps; its golden gap entries WILL change: verify and regenerate those goldens deliberately, never silently).
- Determinism: embedded columns in field order; child tables in field order; snake_case joins with `_`.
- Naming (both targets): embedded column = snake path joined by `_` (`facts.servingSize.amount` → `facts_serving_size_amount`); child table = `<ct table>_<snake path>` (`activity_sessions_quantities`); child FK = `<snake ct name>_id` (`activity_session_id`). Filament child model = `<Model><StudlyPath>` (`ActivitySessionQuantities`).
- Bounded scope (downgrade gaps, not silent drops): `relation` in a component, `ai` on a component scalar, repeatable inside a repeatable, `dynamicZone` (already excluded by the IR from components).
- TDD per task; commits `feat(pkg):` / `test(pkg):`.

---

### Task 1: adapter-kernel — `expandComponents`

**Files:**
- Create: `packages/adapter-kernel/src/expand.ts`
- Modify: `packages/adapter-kernel/src/index.ts` (re-export)
- Test: `packages/adapter-kernel/src/expand.test.ts`

**Interfaces (produces):**

```ts
export interface ExpandedScalar {
  path: string[]; // field-name segments from the owning table's root, length ≥ 2 for embedded
  field: Field;   // the scalar field definition (never relation/component/dynamicZone)
}
export interface ExpandedTable {
  path: string[];          // segments from the content type root, e.g. ["facts", "additional"]
  scalars: ExpandedScalar[]; // paths relative to this table (length ≥ 1)
}
export interface ExpandedContentType {
  scalars: ExpandedScalar[]; // embedded columns from non-repeatable components
  tables: ExpandedTable[];   // one per repeatable component reference
  gaps: CapabilityGap[];
}
export const expandComponents = (doc: IrDocument, ct: ContentType): ExpandedContentType;
```

- [ ] **Step 1: Failing tests** — money-style flatten (`amount` → `amount_minor`, `amount_currency` paths), nutrition-style (nested non-repeatable `servingSize` flattens; repeatable `additional` becomes a table at path `["facts","additional"]` whose scalars keep the component's own fields), repeatable-at-top-level (`quantities`), relation-in-component → downgrade gap, repeatable-inside-repeatable → downgrade gap, ai-scalar-in-component → downgrade gap (field still emitted, ai stripped).
- [ ] **Step 2: Run** `pnpm --filter @camis/adapter-kernel test` — FAIL (module not found).
- [ ] **Step 3: Implement** recursive walk; component defs resolved via `new Map(doc.components.map(c => [c.name, c]))`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(adapter-kernel): target-neutral component expansion`

### Task 2: Filament — embedded columns

**Files:**
- Modify: `packages/adapter-filament/src/fields.ts` (`emitField(field, column?)` — explicit column override, default unchanged)
- Modify: `packages/adapter-filament/src/generate.ts`, `model.ts`, `migration.ts`, `resource.ts` (accept `extraScalars: { column: string; field: Field }[]`, appended after own scalar fields, before FKs)
- Test: extend `packages/adapter-filament/src/generate.test.ts` + new golden fixture `__fixtures__/components.ts` with golden files under `src/__golden__/components/`

- [ ] **Step 1: Failing tests** — a `Transaction { amount: component Money(minor bigInteger, currency string) }` doc: migration contains `$table->bigInteger('amount_minor')` and `$table->string('amount_currency')`; model fillable contains both; form contains `TextInput::make('amount_minor')`; no component gap reported.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — in `generate.ts`, call `expandComponents(doc, ct)`; embedded scalars → `emitField(s.field, snakePath(s.path))`; pass through to model/migration/resource emitters; component fields no longer feed the unsupported-gap branch (replace with expansion gaps).
- [ ] **Step 4: Run** — PASS; inspect blog goldens for expected gap-list changes only.
- [ ] **Step 5: Commit** `feat(adapter-filament): non-repeatable components as embedded columns`

### Task 3: Filament — repeatable components as child tables + Repeater

**Files:**
- Modify: `packages/adapter-filament/src/generate.ts`, `migration.ts` (child migration emitter), `model.ts` (child model emitter + HasMany on parent), `resource.ts` (Repeater form component)
- Test: goldens for `ActivitySession.quantities` and nested `facts.additional`

- [ ] **Step 1: Failing tests** — child migration `create_activity_sessions_quantities_table` with `foreignId('activity_session_id')->constrained('activity_sessions')->cascadeOnDelete()` + component columns; `app/Models/ActivitySessionQuantities.php` with `$fillable`; parent model `quantities(): HasMany`; form has `Repeater::make('quantities')->relationship()->schema([...])`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — child migrations ordinal-numbered after pivots; Repeater import `Filament\Forms\Components\Repeater`; relation method name = camel path join.
- [ ] **Step 4: Run** — PASS + idempotent regen test.
- [ ] **Step 5: Commit** `feat(adapter-filament): repeatable components as child tables with Repeater forms`

### Task 4: Express — embedded columns + child tables

**Files:**
- Modify: `packages/adapter-express/src/schema.ts` (embedded columns + child table blocks + relations), `generate.ts` (expansion wiring, gap replacement)
- Test: extend `packages/adapter-express/src/schema.test.ts`/`generate.test.ts` with the same fixtures

- [ ] **Step 1: Failing tests** — table block contains `amount_minor: integer('amount_minor')` (sqlite) etc.; child table exported as `activity_sessions_quantities` with `activity_session_id` FK referencing parent id; parent relations block has `quantities: many(activity_sessions_quantities)`; no component gap.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — reuse `column(dialect, field)` with a renamed field object `{ ...field, name: pathJoined }`; child blocks appended after pivots.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(adapter-express): component fields as embedded columns and child tables`

### Task 5: OYL corpus + docs + merge

- [ ] **Step 1:** `camis generate` against the imported OYL IR: expect ZERO component gaps on filament and express; spot-read the emitted `ConsumableProduct` migration (17 nutrition columns + serving-size prefix + additional child table).
- [ ] **Step 2:** Docs: CLI README + ARCHITECTURE note on component mapping; PLAN Phase 12 exit criteria met.
- [ ] **Step 3:** `pnpm -r test` + typecheck green; merge `phase-12-component-fields`.
