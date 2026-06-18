# Phase 6C — Filament Permission Spine (Spatie + Ring-1 → PHP Policies) Design

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 6, sub-phase C (of A/B/C) — completes Phase 6.
**Scope:** extend `@camis/adapter-filament` with permission emission: roles → `spatie/laravel-permission`
(a seeder); grant **condition** rules → generated **Laravel Policies** whose method bodies check the
Spatie permission AND the Ring-1 condition (compiled to PHP via `emitPhp` + the embedded `Ring1`
runtime class), fail-closed. Field-level rules → capability-gap (deferred). This is the cross-language
spine: the same predicate enforced in a generated Laravel Policy must match the canonical Ring-1
result — exercised LOCALLY (php is on PATH) and in a gated 3-DB boot-enforcement smoke.

---

## 1. Context & goal

Phase 6 is decomposed A/B/C; 6A (vertical slice) and 6B (breadth) are merged. 6C delivers the Phase 6
exit criteria: an `Article` IR + a role with a condition rule generates a Filament app that boots on
sqlite/mysql/pgsql, enforces Spatie permissions, and enforces the condition via a generated Policy
whose logic matches the Ring-1 conformance result. It mirrors the Phase 5 Strapi permission projection
(`adapter-strapi/src/permissions/`), retargeted from Node/Strapi-conditions to PHP/Laravel-Policies.
The Ring-1 PHP engine (`emitPhp` + `PHP_RUNTIME`) already exists from Phase 4; this phase is its first
use in a generated app.

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Roles → Spatie `laravel-permission`** (a `RolePermissionSeeder`); **conditions → Laravel Policies** with Ring-1 → PHP bodies; **Shield NOT emitted**. | ARCHITECTURE §4: compile to Spatie + Policies, not Shield (churny, unvetted). Shield is optional admin sugar for later. |
| D2 | **Field-level rules → capability-gap** (`downgrade`, deferred). | Laravel/Spatie has no native per-field authorization; Phase 6 exit criteria require only condition rules. Keeps 6C focused; field-level on Filament is a future enhancement. |
| D3 | **Predicate context = `user.*` (always) + `record.<fieldName>` (record-scoped methods only).** A `freeVars` check gaps any var outside `user.* ∪ record.<fields>`. | Laravel Policies receive the model on `view/update/delete/publish`, enabling row-level conditions — a real edge over Strapi's boolean-from-user. viewAny/create have no record, so a `record.*` ref there → `UNKNOWN_VAR` → fail-closed deny (safe by construction). |
| D4 | **Fail-closed Policy bodies:** a method returns `true` only if `$user->can('<key>')` AND (when a condition exists) the Ring-1 result is `{ok:true, value:true}`; any eval-error/non-boolean → deny. | Security default: deny on uncertainty. Generated permission code must enforce, not merely describe. |
| D5 | **The User `HasRoles` trait, `composer require spatie/laravel-permission`, vendor:publish, and migrate are GATED-JOB steps** (sed/composer), NOT camis-generated files. camis emits only IR-derived files (seeder, policies, `Ring1.php`). | "Generated = IR-derived." We don't own Laravel's User model or the Spatie install; the gated boot job wires them, exactly as the Spatie quickstart does. |
| D6 | **`Ring1.php` is `PHP_RUNTIME` wrapped in `namespace App\Support;`**, emitted at `app/Support/Ring1.php`; Policies `use App\Support\Ring1;`. | The conformance-tested runtime is reused verbatim (no drift); PSR-4 autoload requires the namespace. |
| D7 | **Verification = golden + LOCAL PHP tie-in + gated 3-DB boot-enforcement smoke.** The local tie-in runs `emitPhp(condition)` through `Ring1` via `php` and asserts the value equals the Ring-1 TS `evaluate` result. | php is on PATH locally, so the PHP side of the conformance spine runs per-commit (Phase 4 could only do this in gated CI). The boot-enforcement smoke (Spatie + Policy on a real `Gate::allows`) is the exit-criteria oracle, gated (needs composer + DBs). |
| D8 | **Permissions emit only when `roles` is non-empty.** | Keeps the 6A/6B `blog`/`catalog` content goldens byte-identical (no permission files without roles). |

## 3. Packages & dependency direction

`adapter-filament` gains `src/permissions/` and a dep on `@camis/expr-php-emit` (`emitPhp`, `PHP_RUNTIME`).
It already depends on `@camis/permissions` (Role/Grant/FieldRule), `@camis/expr` (`Expression`, `freeVars`),
`@camis/expr-ts` (for the local tie-in test). No sibling-adapter import; all Laravel/Spatie/PHP specifics
confined to this adapter. ESLint adapter rule already permits these shared-package imports.

## 4. Permission key & role naming

- **Permission key:** `<snake_singular>.<action>` (e.g. `article.read`, `article.publish`) — the same
  string the Policy passes to `$user->can(...)` and the seeder registers.
- **Role:** the IR role name verbatim (`Role::create(['name' => '<RoleName>'])`).
- **Action set** (from `@camis/permissions`): `create | read | update | delete | publish`.

## 5. Action → Policy method map

| IR action | Policy method(s) | record context? |
|-----------|------------------|-----------------|
| `read` | `viewAny(User $user)` + `view(User $user, <Model> $record)` | `view` yes; `viewAny` no |
| `create` | `create(User $user)` | no |
| `update` | `update(User $user, <Model> $record)` | yes |
| `delete` | `delete(User $user, <Model> $record)` | yes |
| `publish` | `publish(User $user, <Model> $record)` | yes |

A grant's `condition` applies to every method generated for that grant's actions. Record-scoped methods
build `record.*`; `viewAny`/`create` build only `user.*`.

## 6. Emitted artifacts (overlay; only when roles non-empty)

### 6.1 `database/seeders/RolePermissionSeeder.php`
```
forgetCachedPermissions();
foreach (sorted unique permission keys) Permission::firstOrCreate(['name' => $key]);
foreach (roles) Role::firstOrCreate(['name' => $roleName])->givePermissionTo([...sorted keys for that role]);
```
`firstOrCreate` keeps re-seeding idempotent. Deterministic: keys and roles sorted, deduped.

### 6.2 `app/Policies/<Model>Policy.php`
Per content type that any role grants. Imports: `App\Models\<Model>`, `App\Models\User`, and
`App\Support\Ring1` (only if any method has a condition). Each method:
```php
public function view(User $user, Article $record): bool
{
    if (! $user->can('article.read')) {
        return false;
    }
    $data = [
        'user.id' => $user->id,
        'user.email' => $user->email,
        'user.role' => $user->getRoleNames()->first(),
        'record.<field>' => $record->{<column>},   // each IR field, record-scoped methods only
    ];
    $result = Ring1::<...emitPhp(condition)...>;
    return $result['ok'] === true && $result['value'] === true;
}
```
No-condition methods are just `return $user->can('<key>');`. `record.<fieldName>` maps to the Eloquent
attribute (`$record->{snakeColumn(fieldName)}`), keeping predicates neutral (IR field names).

### 6.3 `app/Support/Ring1.php`
`<?php` + `declare(strict_types=1);` + `namespace App\Support;` + `PHP_RUNTIME` (the `Ring1` class body),
emitted only when at least one Policy has a condition.

## 7. Projection (`adapter-filament/src/permissions/`, mirrors Phase 5)

- **`project.ts`** — `projectFilamentPermissions(doc, roles)` → `{ permissionKeys: string[]; roleGrants: Map<roleName, key[]>; policies: PolicySpec[]; gaps: CapabilityGap[] }`. Walks roles/grants; builds Spatie keys; per content type assembles a `PolicySpec` (the methods + their conditions + which actions); records `downgrade` gaps for field rules (D2) and for predicate vars escaping `user.* ∪ record.<fields>` (D3) via `freeVars`.
- **`policy.ts`** — emits a `<Model>Policy.php` from a `PolicySpec` (the method bodies, the `$data` map per method's record-scopedness, `emitPhp` for conditions, fail-closed return).
- **`seeder.ts`** — emits `RolePermissionSeeder.php`.
- **`ring1.ts`** — emits `app/Support/Ring1.php` (namespaced `PHP_RUNTIME`).
- **`keys.ts`** — `permissionKey(ctName, action)` and the action→Policy-method map.

## 8. Generate wiring

`generate.ts` (after the content/relation emission) calls `projectFilamentPermissions(doc, ir.roles)` when
`ir.roles` is non-empty; appends the seeder, the per-content-type policies, and (if any condition) the
`Ring1.php` file; merges the permission gaps into the report. Empty roles → no permission files (D8).

## 9. Verification

- **Golden** (`__golden__/permissions/`): `RolePermissionSeeder.php`, a `<Model>Policy.php` with a
  condition, and `Ring1.php` — byte-exact for a fixture role.
- **Local PHP tie-in** (`scripts/policy-conformance.mjs`, tsx, runnable since php is on PATH): for the
  fixture's condition predicate, emit a tiny PHP program = the `Ring1` class + `echo json_encode(<emitPhp(condition)>)`
  over a sample `$data`, run via `php`, and assert the value-based result equals `evaluate(condition, data)`
  (the Ring-1 TS interpreter) through the fail-closed mapping. Reuses the Phase 4 `php-conformance`
  harness shape. A per-commit test invokes it (skips gracefully if `php` is absent, like the Phase 4 gate).
- **Gated boot-enforcement smoke** (extends `adapter-filament-boot.yml`): after scaffold + `composer require
  spatie/laravel-permission` + publish + add `HasRoles` (sed) + overlay + migrate +
  `db:seed --class=RolePermissionSeeder`, run a generated/known enforcement script that creates a user, assigns
  the role, creates a record, and asserts `Gate::forUser($user)->allows('view', $record)` (and a denied case)
  match the expected Ring-1 outcomes — on sqlite/mysql/pgsql.

## 10. Testing

- **`project.ts`:** roles → sorted unique Spatie keys; a grant with a condition → a `PolicySpec` method
  carrying that condition; a field rule → a `downgrade` gap; a predicate referencing an out-of-context var
  → a `conditionContext` gap; the action→method map (read → viewAny+view, etc.).
- **`policy.ts`/`seeder.ts`/`ring1.ts`:** golden PHP for the fixture.
- **Tie-in** (§9). **Idempotent** regen. **6A/6B content goldens unchanged** (no roles → no permission files).
- The permission fixture: a role granting `read`/`update` on `Article` with a condition (e.g.
  `eq(var "user.role", lit "editor")` and/or `eq(var "record.status", lit "published")`), no field rules → empty gaps.

## 11. Exit criteria (6C = full Phase 6)

- `Article` IR + a role with a condition rule generates a Filament app that boots on sqlite/mysql/pgsql,
  enforces the Spatie permissions, and enforces the condition via a generated Policy whose logic matches
  the Ring-1 conformance result (local PHP tie-in green; gated boot-enforcement smoke green).
- Field-level rules and out-of-context predicate vars are reported as capability-gaps, not silently dropped.
- `pnpm lint` / `pnpm -r typecheck` / `pnpm -r test` green; 6A/6B content goldens byte-identical.

## 12. Cross-cutting

- The IR is the single source of truth; `permissions` is neutral; all Spatie/Laravel/PHP specifics
  (permission keys, Policy methods, `$user->can`, `getRoleNames`, the `Ring1` embedding) live in
  `adapter-filament`.
- The conformance spine: the generated Policy's predicate uses the byte-identical `Ring1` runtime the
  conformance vectors validate; the local tie-in + gated enforcement prove Policy logic == canonical Ring-1.
- Fail-closed everywhere (D4); deny on eval-error, non-boolean, or missing context var.
- Determinism (D8, sorted/deduped keys, no timestamps) keeps goldens + idempotent regen stable.
