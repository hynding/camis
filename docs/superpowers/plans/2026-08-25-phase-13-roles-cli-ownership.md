# Phase 13 — Roles Through the CLI + Ownership Predicates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `camis generate|build` can emit permission code (Spatie seeder, policies, Express enforcement) from a roles file referenced in the project config, and Ring-1 conditions can express record ownership (`record.ownerId == user.id`) on both backends.

**Architecture:** (1) `projectConfig` gains optional `roles: string` — a path to a JSON array of `Role` (the `@camis/permissions` shape); `generateCommand` loads it, cross-validates with `validateBundle`, and passes real roles instead of the hardcoded `[]`. (2) The owning side of a relation (`manyToOne`/`oneToOne`) exposes a neutral condition variable `record.<fieldName>Id` bound to the FK column — added to the allowed-variable sets and the runtime data builders in both the Filament policy emitter and the Express enforce emitter.

**Spec:** OYL requirement: every `personal`-kind record is owner-scoped (`owner`/`creator` manyToOne → builtin User). Without CLI roles wiring the generated admin panel has no policies at all; without FK exposure the ownership rule is inexpressible (policy `recordData` and express `columnToField` both skip relation fields).

## Global Constraints

- Roles are NOT part of `camis.json` (`IrDocument`); they live in a separate file and join via `IrBundle` — keeps the document schema stable and target-neutral.
- Fail-closed stays intact: unknown vars in conditions still produce `conditionContext` gaps and deny.
- Only owning relations (`manyToOne`, `oneToOne`) expose `record.<name>Id`; collection sides have no FK on the record.
- Existing goldens: filament permissions goldens must not change (fixture has no relation conditions); express secured goldens likewise. New assertions come from new fixtures.

---

### Task 1: CLI — `roles` in config, loaded and validated

**Files:**
- Modify: `packages/cli/src/config.ts` (schema + path resolution)
- Modify: `packages/cli/src/commands/generate.ts` (load roles, `validateBundle`, pass through)
- Test: `packages/cli/src/config.test.ts`, `packages/cli/src/commands/generate.test.ts`, e2e in `packages/cli/src/run.test.ts`

**Interfaces:**
- Produces: `ProjectConfig.roles?: string` (absolute after load); `generateCommand` passes `{ document, roles }` to every adapter.

- [ ] **Step 1: Failing tests** — config with `"roles": "./camis.roles.json"` resolves relative to the config file; generate with a roles file emits `database/seeders/RolePermissionSeeder.php` in the filament dry-run listing / build output; an invalid roles file (grant on unknown content type) exits 1 printing the `unknown_grant_content_type` code; missing `roles` key behaves exactly as today (roles `[]`).
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement** — `roles: z.string().min(1).optional()` in `projectConfig`; resolve like `ir`; in `generateCommand` after IR validation:

```ts
let roles: Role[] = [];
if (cfg.value.roles) {
  const rolesRaw = JSON.parse(await io.readFile(cfg.value.roles));
  const parsed = z.array(role).safeParse(rolesRaw);            // zod Role schema from @camis/permissions
  if (!parsed.success) { /* print + return 1 */ }
  const bundle = validateBundle({ document, roles: parsed.data });
  if (!bundle.ok) { /* print errors + return 1 */ }
  roles = bundle.value.roles;
}
// ...adapterFor(t).generate({ document, roles }, { projectName })
```

- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(cli): roles file in project config drives permission emission`

### Task 2: Filament — ownership variable `record.<name>Id`

**Files:**
- Modify: `packages/adapter-filament/src/permissions/project.ts` (`recordVars` adds `record.<name>Id` for owning relations)
- Modify: `packages/adapter-filament/src/permissions/policy.ts` (`recordData` adds `'record.<name>Id' => $record-><fk>`)
- Test: `packages/adapter-filament/src/permissions/policy.test.ts` (+ project.test if present)

- [ ] **Step 1: Failing test** — content type `Note { text, owner: manyToOne → User }`, role `member` grants `read` with condition `eq(var record.ownerId, var user.id)`: generated `NotePolicy::view` contains `'record.ownerId' => $record->owner_id,` and no `conditionContext` gap is reported.
- [ ] **Step 2:** Run — FAIL (gap emitted today; data row absent).
- [ ] **Step 3: Implement** — both sites iterate `ct.fields.filter(f => f.type === "relation" && (f.relationKind === "manyToOne" || f.relationKind === "oneToOne"))`.
- [ ] **Step 4:** Run — PASS; permissions goldens unchanged.
- [ ] **Step 5: Commit** `feat(adapter-filament): ownership conditions via record.<relation>Id`

### Task 3: Express — ownership variable `record.<name>Id`

**Files:**
- Modify: `packages/adapter-express/src/permissions/project.ts` (`recordFieldNames` adds `<name>Id`)
- Modify: `packages/adapter-express/src/permissions/enforce.ts` (`columnToField` maps `<fk>` → `<name>Id`)
- Test: `packages/adapter-express/src/permissions/` unit tests + a secured-generation assertion

- [ ] **Step 1: Failing test** — same Note/owner fixture: `emitEnforce` output's `COLUMN_TO_FIELD` JSON maps `"owner_id": "ownerId"`; projecting the ownership condition produces no `conditionContext` gap.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** `feat(adapter-express): ownership conditions via record.<relation>Id`

### Task 4: OYL roles demo + docs + merge

- [ ] **Step 1:** Author `oyl.camis.roles.json` in the scratchpad (roles `admin` — all actions on all types; `member` — CRUD on personal types with `record.ownerId == user.id` / catalog reads unconditioned); `camis build` with it; verify `RolePermissionSeeder.php` + `app/Policies/*.php` + `app/Support/Ring1.php` appear and `TransactionPolicy::view` checks `owner_id`.
- [ ] **Step 2:** Docs: CLI README (`roles` key, ownership variable convention); PLAN exit criteria.
- [ ] **Step 3:** `pnpm -r test` + typecheck; merge `phase-13-roles-cli-ownership`.
