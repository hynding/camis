# Phase 6C — Filament Permission Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit Laravel permissions for the Filament target — roles → a `spatie/laravel-permission` seeder, and grant condition rules → Laravel Policies whose fail-closed bodies enforce the Spatie permission AND the Ring-1 condition (compiled to PHP via `emitPhp` + the embedded `Ring1` runtime).

**Architecture:** A new `adapter-filament/src/permissions/` module (mirroring the Phase 5 Strapi projection) builds Spatie keys, per-content-type Policy specs, and capability-gaps; emitters produce the seeder, policies, and a namespaced `Ring1.php`. `generate.ts` wires it when `roles` is non-empty (content goldens unchanged otherwise). A local PHP tie-in (php is on PATH) proves Policy predicate ≡ Ring-1; a gated 3-DB boot-enforcement smoke proves runtime enforcement.

**Tech Stack:** TypeScript (strict, ESM), Vitest, emitted PHP (Laravel 12, Filament v5, `spatie/laravel-permission` v7, the `Ring1` class from `@camis/expr-php-emit`).

**Design spec:** `docs/superpowers/specs/2026-06-17-phase-6c-filament-permissions-design.md`

> **Decisions pinned here (consistent with the spec):** conditions are keyed per `(contentType, action)` because a Spatie permission/Policy is role-agnostic — at most ONE condition per content-type-action; two roles granting the same action with DIVERGENT conditions → a `conditionConflict` downgrade gap (the first condition, by role/document order, is used). `record.*` exposes NON-relation fields only (scalar Eloquent attributes). Permissions emit only when `roles` is non-empty, so 6A/6B `blog`/`catalog` content goldens stay byte-identical.

---

## File structure (all under `packages/adapter-filament/`)

- `src/permissions/keys.ts` — `permissionKey`, `POLICY_METHODS`, `USER_CONTEXT`.
- `src/permissions/project.ts` — `projectFilamentPermissions(doc, roles)` → keys, role grants, policy specs, gaps.
- `src/permissions/ring1.ts` — `emitRing1File()` (namespaced `PHP_RUNTIME`).
- `src/permissions/policy.ts` — `emitPolicy(spec)` (the Policy PHP).
- `src/permissions/seeder.ts` — `emitSeeder(keys, roleGrants)`.
- `src/permissions/emit.ts` — `emitPermissions(doc, roles)` assembling files + gaps.
- `src/generate.ts` — wire `emitPermissions`.
- `src/__fixtures__/permissions.ts` — a role-with-condition `IrBundle`.
- `scripts/policy-conformance.mjs` — local PHP tie-in.
- `.github/workflows/adapter-filament-boot.yml` — extend with Spatie install + seed + enforcement.
- tests + `src/__golden__/permissions/*`.

---

## Task 1: Package deps + keys (`keys.ts`)

**Files:** Modify `packages/adapter-filament/package.json`; Create `packages/adapter-filament/src/permissions/keys.ts`, `packages/adapter-filament/src/permissions/keys.test.ts`.

- [ ] **Step 1: Add deps** — Run:
```bash
pnpm --filter @camis/adapter-filament add "@camis/expr@workspace:*" "@camis/expr-ts@workspace:*" "@camis/expr-php-emit@workspace:*"
```
(Quote the specs — zsh globs the `*`.) Confirm all three appear in dependencies.

- [ ] **Step 2: Failing test** — `packages/adapter-filament/src/permissions/keys.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { permissionKey, POLICY_METHODS } from "./keys";

describe("keys", () => {
  it("builds a snake-singular dotted permission key", () => {
    expect(permissionKey("Article", "read")).toBe("article.read");
    expect(permissionKey("BlogPost", "create")).toBe("blog_post.create");
  });
  it("maps read to viewAny + view, with record-scopedness", () => {
    expect(POLICY_METHODS.read).toEqual([
      { method: "viewAny", record: false },
      { method: "view", record: true },
    ]);
    expect(POLICY_METHODS.update).toEqual([{ method: "update", record: true }]);
  });
});
```

- [ ] **Step 3: Run red:** `pnpm --filter @camis/adapter-filament exec vitest run src/permissions/keys.test.ts`.

- [ ] **Step 4: Implement** `packages/adapter-filament/src/permissions/keys.ts`
```ts
import type { Action } from "@camis/permissions";
import { snake } from "../names";

export const USER_CONTEXT = ["user.id", "user.email", "user.role"] as const;

export const permissionKey = (contentType: string, action: Action): string =>
  `${snake(contentType)}.${action}`;

export interface PolicyMethod {
  method: string;
  record: boolean;
}

export const POLICY_METHODS: Record<Action, PolicyMethod[]> = {
  read: [
    { method: "viewAny", record: false },
    { method: "view", record: true },
  ],
  create: [{ method: "create", record: false }],
  update: [{ method: "update", record: true }],
  delete: [{ method: "delete", record: true }],
  publish: [{ method: "publish", record: true }],
};
```

- [ ] **Step 5: Run green:** `pnpm --filter @camis/adapter-filament exec vitest run src/permissions/keys.test.ts`; `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 6: Commit**
```bash
git add packages/adapter-filament/package.json packages/adapter-filament/src/permissions/keys.ts packages/adapter-filament/src/permissions/keys.test.ts pnpm-lock.yaml
git commit -m "feat(adapter-filament): permission keys + Policy method map

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Permission projection (`project.ts`)

Projects roles → Spatie keys + per-content-type Policy specs + gaps (field rules; out-of-context vars; condition conflicts).

**Files:** Create `packages/adapter-filament/src/permissions/project.ts`, `packages/adapter-filament/src/permissions/project.test.ts`.

- [ ] **Step 1: Failing test** — `packages/adapter-filament/src/permissions/project.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { projectFilamentPermissions } from "./project";

const doc: IrDocument = {
  version: 1,
  contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }, { type: "string", name: "status" }] }],
  components: [],
};

const condition = { kind: "eq", left: { kind: "var", name: "record.status" }, right: { kind: "lit", value: "published" } } as const;

describe("projectFilamentPermissions", () => {
  it("emits sorted Spatie keys, role grants, and a policy spec carrying the condition", () => {
    const roles: Role[] = [{ name: "Editor", grants: [{ contentType: "Article", actions: ["read", "update"], condition }] }];
    const out = projectFilamentPermissions(doc, roles);
    expect(out.permissionKeys).toEqual(["article.read", "article.update"]);
    expect(out.roleGrants).toEqual([{ role: "Editor", keys: ["article.read", "article.update"] }]);
    const article = out.policies.find((p) => p.contentType === "Article")!;
    expect(article.methods.map((m) => m.method)).toEqual(["viewAny", "view", "update"]);
    expect(article.methods.find((m) => m.method === "view")!.condition).toEqual(condition);
    expect(out.gaps).toEqual([]);
  });
  it("gaps a field-level rule", () => {
    const roles: Role[] = [{ name: "R", grants: [{ contentType: "Article", actions: ["read"], fieldRules: [{ field: "status", access: "read" }] }] }];
    expect(projectFilamentPermissions(doc, roles).gaps.some((g) => g.feature === "fieldRule")).toBe(true);
  });
  it("gaps a predicate var outside user.* and record.<fields>", () => {
    const bad = { kind: "var", name: "request.ip" } as const;
    const roles: Role[] = [{ name: "R", grants: [{ contentType: "Article", actions: ["read"], condition: bad }] }];
    expect(projectFilamentPermissions(doc, roles).gaps.some((g) => g.feature === "conditionContext")).toBe(true);
  });
});
```

- [ ] **Step 2: Run red:** `pnpm --filter @camis/adapter-filament exec vitest run src/permissions/project.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-filament/src/permissions/project.ts`
```ts
import type { Expression } from "@camis/expr";
import { freeVars } from "@camis/expr";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { filamentNames } from "../names";
import { permissionKey, POLICY_METHODS, USER_CONTEXT } from "./keys";

export interface PolicyMethodSpec {
  method: string;
  key: string;
  record: boolean;
  condition?: Expression;
}
export interface PolicySpec {
  contentType: string;
  model: string;
  methods: PolicyMethodSpec[];
}
export interface FilamentPermissions {
  permissionKeys: string[];
  roleGrants: { role: string; keys: string[] }[];
  policies: PolicySpec[];
  gaps: CapabilityGap[];
}

const recordVars = (ct: ContentType): Set<string> =>
  new Set(ct.fields.filter((f) => f.type !== "relation").map((f) => `record.${f.name}`));

export const projectFilamentPermissions = (doc: IrDocument, roles: Role[]): FilamentPermissions => {
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const keys = new Set<string>();
  const gaps: CapabilityGap[] = [];
  const roleGrants: { role: string; keys: string[] }[] = [];
  // (contentType, action) -> condition (first wins; conflicts gapped)
  const condByCa = new Map<string, Expression>();
  const actionsByCt = new Map<string, Set<string>>();

  for (const role of roles) {
    const roleKeys = new Set<string>();
    for (const grant of role.grants) {
      const ct = byName.get(grant.contentType);
      if (!ct) continue;
      if (grant.fieldRules && grant.fieldRules.length > 0) {
        for (const fr of grant.fieldRules) {
          gaps.push({
            feature: "fieldRule",
            location: { contentType: grant.contentType, field: fr.field, rule: role.name },
            severity: "downgrade",
            message: `field-level rule on "${grant.contentType}.${fr.field}" is not supported by the Filament target`,
          });
        }
      }
      if (grant.condition) {
        const allowed = new Set<string>([...USER_CONTEXT, ...recordVars(ct)]);
        const escaping = freeVars(grant.condition).filter((v) => !allowed.has(v));
        if (escaping.length > 0) {
          gaps.push({
            feature: "conditionContext",
            location: { contentType: grant.contentType, rule: role.name },
            severity: "downgrade",
            message: `condition references ${escaping.join(", ")} outside user.* and record.<field>; it will deny`,
          });
        }
      }
      for (const action of grant.actions) {
        const key = permissionKey(grant.contentType, action);
        keys.add(key);
        roleKeys.add(key);
        const set = actionsByCt.get(grant.contentType) ?? new Set<string>();
        set.add(action);
        actionsByCt.set(grant.contentType, set);
        if (grant.condition) {
          const ca = `${grant.contentType}.${action}`;
          const existing = condByCa.get(ca);
          if (existing && JSON.stringify(existing) !== JSON.stringify(grant.condition)) {
            gaps.push({
              feature: "conditionConflict",
              location: { contentType: grant.contentType, rule: role.name },
              severity: "downgrade",
              message: `multiple roles grant "${ca}" with different conditions; only the first is enforced`,
            });
          } else if (!existing) {
            condByCa.set(ca, grant.condition);
          }
        }
      }
    }
    roleGrants.push({ role: role.name, keys: [...roleKeys].sort() });
  }

  const policies: PolicySpec[] = [...actionsByCt.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ctName, actions]): PolicySpec => {
      const methods: PolicyMethodSpec[] = [];
      for (const action of [...actions].sort()) {
        for (const pm of POLICY_METHODS[action as keyof typeof POLICY_METHODS]) {
          const condition = condByCa.get(`${ctName}.${action}`);
          methods.push({ method: pm.method, key: permissionKey(ctName, action as never), record: pm.record, ...(condition ? { condition } : {}) });
        }
      }
      return { contentType: ctName, model: filamentNames(byName.get(ctName) as ContentType).model, methods };
    });

  return { permissionKeys: [...keys].sort(), roleGrants: roleGrants.sort((a, b) => a.role.localeCompare(b.role)), policies, gaps };
};
```
(`snakeColumn` belongs in `policy.ts` (Task 4), not here — `project.ts` references record vars by IR field name only.)

- [ ] **Step 4: Run green:** `pnpm --filter @camis/adapter-filament exec vitest run src/permissions/project.test.ts`; `pnpm --filter @camis/adapter-filament typecheck`; `pnpm --filter @camis/adapter-filament lint`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/permissions/project.ts packages/adapter-filament/src/permissions/project.test.ts
git commit -m "feat(adapter-filament): project roles to Spatie keys + policy specs + gaps

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Ring1 runtime file (`ring1.ts`)

**Files:** Create `packages/adapter-filament/src/permissions/ring1.ts`, `packages/adapter-filament/src/permissions/ring1.test.ts`.

- [ ] **Step 1: Failing test** — `packages/adapter-filament/src/permissions/ring1.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { emitRing1File } from "./ring1";

describe("emitRing1File", () => {
  it("namespaces the conformance-tested Ring1 runtime for PSR-4", () => {
    const php = emitRing1File();
    expect(php.startsWith("<?php\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n")).toBe(true);
    expect(php).toContain("class Ring1");
    expect(php).toContain("public static function eq(");
  });
});
```

- [ ] **Step 2: Run red:** `pnpm --filter @camis/adapter-filament exec vitest run src/permissions/ring1.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-filament/src/permissions/ring1.ts`
```ts
import { PHP_RUNTIME } from "@camis/expr-php-emit";

// The conformance-tested Ring1 class, namespaced for the generated app's PSR-4 autoload.
// PHP_RUNTIME begins with "<?php" and the class body; strip the opening tag and re-emit with a namespace.
export const emitRing1File = (): string => {
  const body = PHP_RUNTIME.replace(/^<\?php\s*/, "");
  return `<?php\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n\n${body.trimStart()}`;
};
```
Note: inspect `PHP_RUNTIME` (it starts with `<?php`). If it already contains `declare`/`namespace`, adjust the regex so the result has exactly one `<?php` + `declare` + `namespace App\Support;` then the class. The test pins the prefix; make it pass without duplicating `<?php`.

- [ ] **Step 4: Run green:** `pnpm --filter @camis/adapter-filament exec vitest run src/permissions/ring1.test.ts`; `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/permissions/ring1.ts packages/adapter-filament/src/permissions/ring1.test.ts
git commit -m "feat(adapter-filament): emit namespaced Ring1 runtime for generated policies

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Policy emitter (`policy.ts`)

Emits `app/Policies/<Model>Policy.php` from a `PolicySpec`: each method checks the Spatie permission, then (if a condition) builds `$data` (user.* always; record.<field> for record-scoped methods) and returns the fail-closed Ring-1 result.

**Files:** Create `packages/adapter-filament/src/permissions/policy.ts`, `packages/adapter-filament/src/permissions/policy.test.ts`.

- [ ] **Step 1: Failing test** — `packages/adapter-filament/src/permissions/policy.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import type { PolicySpec } from "./project";
import { emitPolicy } from "./policy";

const article: ContentType = { name: "Article", kind: "collection", fields: [{ type: "string", name: "status" }] } as ContentType;
const spec: PolicySpec = {
  contentType: "Article",
  model: "Article",
  methods: [
    { method: "viewAny", key: "article.read", record: false },
    { method: "view", key: "article.read", record: true, condition: { kind: "eq", left: { kind: "var", name: "record.status" }, right: { kind: "lit", value: "published" } } },
    { method: "create", key: "article.create", record: false },
  ],
};

describe("emitPolicy", () => {
  const php = emitPolicy(spec, article);
  it("emits a namespaced policy class using Ring1 + models", () => {
    expect(php).toContain("namespace App\\Policies;");
    expect(php).toContain("use App\\Models\\Article;");
    expect(php).toContain("use App\\Support\\Ring1;");
  });
  it("no-condition method is a bare permission check", () => {
    expect(php).toContain("public function create(User $user): bool");
    expect(php).toContain("return $user->can('article.create');");
  });
  it("record-scoped condition method builds record.* data and is fail-closed", () => {
    expect(php).toContain("public function view(User $user, Article $record): bool");
    expect(php).toContain("if (! $user->can('article.read')) {");
    expect(php).toContain("'record.status' => $record->status,");
    expect(php).toContain("return $result['ok'] === true && $result['value'] === true;");
    expect(php).toContain("Ring1::eq(");
  });
});
```

- [ ] **Step 2: Run red:** `pnpm --filter @camis/adapter-filament exec vitest run src/permissions/policy.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-filament/src/permissions/policy.ts`
```ts
import { emitPhp } from "@camis/expr-php-emit";
import type { ContentType } from "@camis/ir-schema";
import { snakeColumn } from "../names";
import type { PolicyMethodSpec, PolicySpec } from "./project";

const userData = [
  "            'user.id' => $user->id,",
  "            'user.email' => $user->email,",
  "            'user.role' => $user->getRoleNames()->first(),",
];

const recordData = (ct: ContentType): string[] =>
  ct.fields
    .filter((f) => f.type !== "relation")
    .map((f) => `            'record.${f.name}' => $record->${snakeColumn(f.name)},`);

const method = (m: PolicyMethodSpec, ct: ContentType): string => {
  const sig = m.record
    ? `    public function ${m.method}(User $user, ${ct.name} $record): bool`
    : `    public function ${m.method}(User $user): bool`;
  if (!m.condition) {
    return `${sig}\n    {\n        return $user->can('${m.key}');\n    }`;
  }
  const data = [...userData, ...(m.record ? recordData(ct) : [])].join("\n");
  return `${sig}
    {
        if (! $user->can('${m.key}')) {
            return false;
        }
        $data = [
${data}
        ];
        $result = ${emitPhp(m.condition)};
        return $result['ok'] === true && $result['value'] === true;
    }`;
};

export const emitPolicy = (spec: PolicySpec, ct: ContentType): string => {
  const hasCondition = spec.methods.some((m) => m.condition !== undefined);
  const ring1Use = hasCondition ? "use App\\Support\\Ring1;\n" : "";
  const body = spec.methods.map((m) => method(m, ct)).join("\n\n");
  return `<?php

declare(strict_types=1);

namespace App\\Policies;

use App\\Models\\${spec.model};
use App\\Models\\User;
${ring1Use}
class ${spec.model}Policy
{
${body}
}
`;
};
```

- [ ] **Step 4: Run green:** `pnpm --filter @camis/adapter-filament exec vitest run src/permissions/policy.test.ts`; `pnpm --filter @camis/adapter-filament typecheck`; `pnpm --filter @camis/adapter-filament lint`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/permissions/policy.ts packages/adapter-filament/src/permissions/policy.test.ts
git commit -m "feat(adapter-filament): emit Laravel policies with Ring-1 PHP condition bodies

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Seeder emitter (`seeder.ts`)

**Files:** Create `packages/adapter-filament/src/permissions/seeder.ts`, `packages/adapter-filament/src/permissions/seeder.test.ts`.

- [ ] **Step 1: Failing test** — `packages/adapter-filament/src/permissions/seeder.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { emitSeeder } from "./seeder";

describe("emitSeeder", () => {
  const php = emitSeeder(["article.read", "article.update"], [{ role: "Editor", keys: ["article.read", "article.update"] }]);
  it("creates permissions and roles idempotently", () => {
    expect(php).toContain("class RolePermissionSeeder extends Seeder");
    expect(php).toContain("forgetCachedPermissions();");
    expect(php).toContain("Permission::firstOrCreate(['name' => 'article.read']);");
    expect(php).toContain("Role::firstOrCreate(['name' => 'Editor'])->givePermissionTo(['article.read', 'article.update']);");
  });
});
```

- [ ] **Step 2: Run red:** `pnpm --filter @camis/adapter-filament exec vitest run src/permissions/seeder.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-filament/src/permissions/seeder.ts`
```ts
export const emitSeeder = (
  permissionKeys: string[],
  roleGrants: { role: string; keys: string[] }[],
): string => {
  const perms = permissionKeys.map((k) => `        Permission::firstOrCreate(['name' => '${k}']);`).join("\n");
  const roles = roleGrants
    .map((r) => `        Role::firstOrCreate(['name' => '${r.role}'])->givePermissionTo([${r.keys.map((k) => `'${k}'`).join(", ")}]);`)
    .join("\n");
  return `<?php

declare(strict_types=1);

namespace Database\\Seeders;

use Illuminate\\Database\\Seeder;
use Spatie\\Permission\\Models\\Permission;
use Spatie\\Permission\\Models\\Role;
use Spatie\\Permission\\PermissionRegistrar;

class RolePermissionSeeder extends Seeder
{
    public function run(): void
    {
        app(PermissionRegistrar::class)->forgetCachedPermissions();

${perms}

${roles}
    }
}
`;
};
```

- [ ] **Step 4: Run green:** `pnpm --filter @camis/adapter-filament exec vitest run src/permissions/seeder.test.ts`; `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/permissions/seeder.ts packages/adapter-filament/src/permissions/seeder.test.ts
git commit -m "feat(adapter-filament): emit Spatie RolePermissionSeeder

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Assemble + wire into generate (`emit.ts` + `generate.ts`)

**Files:** Create `packages/adapter-filament/src/permissions/emit.ts`; Modify `packages/adapter-filament/src/generate.ts`, `packages/adapter-filament/src/generate.test.ts`.

- [ ] **Step 1: Implement** `packages/adapter-filament/src/permissions/emit.ts`
```ts
import type { GeneratedFile } from "@camis/adapter-kernel";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { filamentNames } from "../names";
import { emitPolicy } from "./policy";
import { projectFilamentPermissions } from "./project";
import { emitRing1File } from "./ring1";
import { emitSeeder } from "./seeder";

export interface PermissionEmission {
  files: GeneratedFile[];
  gaps: CapabilityGap[];
}

export const emitPermissions = (doc: IrDocument, roles: Role[]): PermissionEmission => {
  if (roles.length === 0) return { files: [], gaps: [] };
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const { permissionKeys, roleGrants, policies, gaps } = projectFilamentPermissions(doc, roles);
  const files: GeneratedFile[] = [
    { path: "database/seeders/RolePermissionSeeder.php", content: emitSeeder(permissionKeys, roleGrants) },
  ];
  for (const spec of policies) {
    files.push({ path: `app/Policies/${spec.model}Policy.php`, content: emitPolicy(spec, byName.get(spec.contentType) as ContentType) });
  }
  if (policies.some((p) => p.methods.some((m) => m.condition !== undefined))) {
    files.push({ path: "app/Support/Ring1.php", content: emitRing1File() });
  }
  return { files, gaps };
};
```

- [ ] **Step 2: Failing test** — append to `packages/adapter-filament/src/generate.test.ts`:
```ts
import { permissionsBundle } from "./__fixtures__/permissions";

describe("filamentAdapter permissions", () => {
  const result = filamentAdapter.generate(permissionsBundle, { projectName: "blog" });
  const paths = result.files.map((f) => f.path);
  it("emits the seeder, policy, and Ring1 support file", () => {
    expect(paths).toContain("database/seeders/RolePermissionSeeder.php");
    expect(paths).toContain("app/Policies/ArticlePolicy.php");
    expect(paths).toContain("app/Support/Ring1.php");
  });
  it("has no gaps for the user.*/record.* fixture", () => {
    expect(result.gaps.gaps).toEqual([]);
  });
});
```
(Create the fixture in Task 7 Step 1 first if running tasks in order; or inline a minimal bundle here. Since Task 7 creates `__fixtures__/permissions.ts`, this import resolves once Task 7 lands — to keep THIS task self-contained, create `__fixtures__/permissions.ts` now as part of Step 2 with the content shown in Task 7 Step 1, and Task 7 reuses it.)

- [ ] **Step 3: Wire `generate.ts`** — add the import and, after the pivot-migration emission and before the final `return`, merge permission files + gaps:
```ts
import { emitPermissions } from "./permissions/emit";
// ... at the end of generate, replace the final return with:
    const perm = emitPermissions(doc, ir.roles);
    const allFiles = [...files, ...perm.files];
    return {
      files: allFiles,
      manifest: buildManifest(allFiles),
      gaps: { target: "filament", gaps: [...gaps, ...perm.gaps] },
    };
```
(`ir.roles` is the bundle's roles — previously ignored. `files`/`gaps` are the content/relation arrays already built.)

- [ ] **Step 4: Run green + regression:** `pnpm --filter @camis/adapter-filament test` (all green; catalog/blog content goldens unchanged — they have `roles: []`), `pnpm --filter @camis/adapter-filament typecheck`, `pnpm --filter @camis/adapter-filament lint`, and `git status --short packages/adapter-filament/src/__golden__/` shows NO change to existing goldens.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/permissions/emit.ts packages/adapter-filament/src/generate.ts packages/adapter-filament/src/generate.test.ts packages/adapter-filament/src/__fixtures__/permissions.ts
git commit -m "feat(adapter-filament): wire permission emission into generate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Fixture + permission goldens

**Files:** Create `packages/adapter-filament/src/__fixtures__/permissions.ts` (if not already from Task 6), `packages/adapter-filament/src/permissions/golden.test.ts`, generated `src/__golden__/permissions/*`.

- [ ] **Step 1: Fixture** `packages/adapter-filament/src/__fixtures__/permissions.ts`
```ts
import type { IrBundle } from "@camis/permissions";

export const permissionsBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      { name: "Article", kind: "collection", fields: [
        { type: "string", name: "title", required: true },
        { type: "string", name: "status" },
      ] },
    ],
    components: [],
  },
  roles: [
    {
      name: "Editor",
      grants: [
        {
          contentType: "Article",
          actions: ["read", "update"],
          condition: { kind: "eq", left: { kind: "var", name: "record.status" }, right: { kind: "lit", value: "published" } },
        },
      ],
    },
  ],
};
```

- [ ] **Step 2: Golden test** `packages/adapter-filament/src/permissions/golden.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { permissionsBundle } from "../__fixtures__/permissions";

describe("permissions golden", () => {
  const result = filamentAdapter.generate(permissionsBundle, { projectName: "blog" });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("seeder golden", async () => {
    await expect(content("database/seeders/RolePermissionSeeder.php")).toMatchFileSnapshot("./__golden__/permissions/RolePermissionSeeder.php");
  });
  it("policy golden", async () => {
    await expect(content("app/Policies/ArticlePolicy.php")).toMatchFileSnapshot("./__golden__/permissions/ArticlePolicy.php");
  });
  it("Ring1 support golden", async () => {
    await expect(content("app/Support/Ring1.php")).toMatchFileSnapshot("./__golden__/permissions/Ring1.php");
  });
  it("regeneration is idempotent", () => {
    expect(filamentAdapter.generate(permissionsBundle, { projectName: "blog" })).toEqual(result);
  });
});
```

- [ ] **Step 3: Generate + INSPECT** — `pnpm --filter @camis/adapter-filament exec vitest run src/permissions/golden.test.ts -u`. Read `src/__golden__/permissions/`: the seeder has `firstOrCreate` for `article.read`/`article.update` + the Editor role; `ArticlePolicy.php` has `viewAny`/`view`/`update` methods, `view`/`update` building `'record.status' => $record->status` and the fail-closed `Ring1::eq(...)` body, `viewAny` (no record) building only user.* data; `Ring1.php` is namespaced `App\Support` and contains the `Ring1` class. If anything is wrong, STOP and report (emitter bug), do not hand-edit.

- [ ] **Step 4: Run green:** `pnpm --filter @camis/adapter-filament test` (all green; 6A/6B content goldens untouched), `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/__fixtures__/permissions.ts packages/adapter-filament/src/permissions/golden.test.ts packages/adapter-filament/src/__golden__/permissions
git commit -m "test(adapter-filament): permission goldens (seeder, policy, Ring1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Local PHP tie-in (self-contained test)

A self-contained Vitest test runs `emitPhp(condition)` through the `Ring1` class via `php` and asserts the value-based result equals the Ring-1 TS `evaluate`. It executes `php` directly (no nested pnpm/tsx) and SKIPS gracefully if `php` is absent. This exercises the PHP side of the cross-runtime spine per-commit.

**Files:** Create `packages/adapter-filament/src/permissions/tie-in.test.ts`.

- [ ] **Step 1: Self-contained test** `packages/adapter-filament/src/permissions/tie-in.test.ts`
```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { evaluate } from "@camis/expr-ts";
import { emitPhp, PHP_RUNTIME } from "@camis/expr-php-emit";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const condition: Expression = {
  kind: "eq",
  left: { kind: "var", name: "record.status" },
  right: { kind: "lit", value: "published" },
};

const cases: Record<string, string | null>[] = [
  { "record.status": "published" },
  { "record.status": "draft" },
  {},
];

describe("policy PHP conformance tie-in", () => {
  let dir = "";
  let runtimePath = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "policy-conf-"));
    runtimePath = join(dir, "Ring1.php");
    writeFileSync(runtimePath, PHP_RUNTIME);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasPhp())("emitted Policy condition in PHP matches the Ring-1 TS interpreter", () => {
    for (const data of cases) {
      const php = `<?php require '${runtimePath}'; $data = json_decode('${JSON.stringify(data)}', true) ?? []; echo json_encode(${emitPhp(condition)});`;
      const file = join(dir, "c.php");
      writeFileSync(file, php);
      const got = JSON.parse(execFileSync("php", [file], { encoding: "utf8" })) as unknown;
      const want = evaluate(condition, data as Record<string, string | null>);
      expect(got).toEqual(want);
    }
  });
});
```

- [ ] **Step 2: Run** — `pnpm --filter @camis/adapter-filament exec vitest run src/permissions/tie-in.test.ts`. If `php` is on PATH the test PASSES (the emitted PHP result equals `evaluate` for all three cases — published→`{ok:true,value:true}`, draft→`{ok:true,value:false}`, missing→`{ok:false,error:"UNKNOWN_VAR"}`); if absent it SKIPS. Report which occurred. Then `pnpm --filter @camis/adapter-filament typecheck` and `pnpm --filter @camis/adapter-filament lint`.

- [ ] **Step 3: Commit**
```bash
git add packages/adapter-filament/src/permissions/tie-in.test.ts
git commit -m "test(adapter-filament): local PHP tie-in — Policy condition matches Ring-1

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Gated boot-enforcement smoke + sweep

**Files:** Modify `.github/workflows/adapter-filament-boot.yml`, `packages/adapter-filament/scripts/overlay.ts`.

- [ ] **Step 1: Overlay the permission bundle in CI** — the boot job materializes via `scripts/overlay.ts`. Point a SECOND overlay step (or env-selected fixture) at `permissionsBundle` so the seeder/policies/Ring1 land. Simplest: extend `overlay.ts` to accept a fixture name argv[3] (`catalog` default, `permissions` opt-in) — modify `overlay.ts`:
```ts
import { materialize } from "@camis/adapter-kernel";
import { filamentAdapter } from "../src/generate";
import { catalog } from "../src/__fixtures__/catalog";
import { permissionsBundle } from "../src/__fixtures__/permissions";

const dest = process.argv[2];
const which = process.argv[3] ?? "catalog";
if (!dest) {
  console.error("usage: tsx scripts/overlay.ts <laravel-app-dir> [catalog|permissions]");
  process.exit(1);
}
const bundle = which === "permissions" ? permissionsBundle : catalog;
await materialize(filamentAdapter.generate(bundle, { projectName: "blog" }), dest);
console.log(`overlay (${which}) materialized into ${dest}`);
```

- [ ] **Step 2: Extend the workflow** — in `.github/workflows/adapter-filament-boot.yml`, after the existing scaffold steps add Spatie install + the permission overlay + seed + an enforcement assertion. Insert these steps (after `filament:install`, before/replacing the final migrate step):
```yaml
      - name: Install Spatie + HasRoles
        run: |
          cd app
          composer require spatie/laravel-permission --no-interaction
          php artisan vendor:publish --provider="Spatie\Permission\PermissionServiceProvider" --no-interaction
          php -r '$f="app/Models/User.php";$c=file_get_contents($f);$c=str_replace("use Notifiable;","use Notifiable, \\Spatie\\Permission\\Traits\\HasRoles;",$c);file_put_contents($f,$c);'
      - name: Overlay camis files (content + permissions)
        run: |
          pnpm --filter @camis/adapter-filament overlay "$GITHUB_WORKSPACE/app" permissions
      - name: Configure DB env (${{ matrix.db }})
        run: |
          cd app
          case "${{ matrix.db }}" in
            sqlite) echo "DB_CONNECTION=sqlite" >> .env; touch database/database.sqlite ;;
            mysql)  printf 'DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=camis\nDB_USERNAME=root\nDB_PASSWORD=camis\n' >> .env ;;
            pgsql)  printf 'DB_CONNECTION=pgsql\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_DATABASE=camis\nDB_USERNAME=postgres\nDB_PASSWORD=camis\n' >> .env ;;
          esac
      - name: Migrate + seed + enforce
        run: |
          cd app
          php artisan migrate --force
          php artisan db:seed --class=Database\\Seeders\\RolePermissionSeeder --force
          php artisan tinker --execute='
            $u = \App\Models\User::factory()->create();
            $u->assignRole("Editor");
            $published = new \App\Models\Article(["status" => "published"]);
            $draft = new \App\Models\Article(["status" => "draft"]);
            $allow = \Illuminate\Support\Facades\Gate::forUser($u)->allows("view", $published);
            $deny = \Illuminate\Support\Facades\Gate::forUser($u)->allows("view", $draft);
            if ($allow !== true || $deny !== false) { fwrite(STDERR, "ENFORCEMENT MISMATCH allow=".var_export($allow,true)." deny=".var_export($deny,true)); exit(1); }
            echo "ENFORCEMENT OK";
          '
```
(Replace the prior single `migrate` step. Keep the existing matrix/services/scaffold steps. The `tinker --execute` enforcement asserts the generated `ArticlePolicy::view` allows a published record and denies a draft — matching the Ring-1 condition `record.status == 'published'`.)

- [ ] **Step 3: Full sweep** — run and report:
```bash
pnpm lint
pnpm -r typecheck
pnpm -r test
```
All green. (The gated workflow is not run locally.)

- [ ] **Step 4: Commit**
```bash
git add .github/workflows/adapter-filament-boot.yml packages/adapter-filament/scripts/overlay.ts
git commit -m "ci(adapter-filament): gated boot enforces a generated Policy condition on 3 DBs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** D1 Spatie seeder + Policies, no Shield (Tasks 5,4) · D2 field-rule gap (Task 2) · D3 user.*+record.* context + freeVars gap (Tasks 2,4) · D4 fail-closed bodies (Task 4) · D5 Spatie/HasRoles as gated-job steps (Task 9) · D6 namespaced Ring1 (Task 3) · D7 golden + local PHP tie-in + gated enforcement (Tasks 7,8,9) · D8 emit only when roles non-empty (Task 6). Exit criteria: seeder+policy+Ring1 generated & golden (Task 7); local tie-in (Task 8); gated 3-DB enforcement (Task 9); content goldens unchanged (Task 6 regression).

**Placeholder scan:** none — concrete code/PHP throughout. Goldens generated via `-u` then inspected (Task 7). Pinned the conditions-per-(contentType,action) + conditionConflict gap + record.*-non-relation decisions at the top (consistent with the spec's per-grant condition model).

**Type consistency:** `permissionKey`/`POLICY_METHODS`/`USER_CONTEXT` (Task 1) used by `project.ts` (2) and `policy.ts` (4). `PolicySpec`/`PolicyMethodSpec`/`FilamentPermissions` (Task 2) consumed by `policy.ts` (4), `emit.ts` (6). `emitPolicy(spec, ct)` (4), `emitSeeder(keys, roleGrants)` (5), `emitRing1File()` (3) consumed by `emit.ts` (6). `emitPermissions(doc, roles)` (6) wired into `generate.ts` (6). `permissionsBundle` (7) used by generate.test (6) + golden (7) + overlay (9). `emitPhp`/`PHP_RUNTIME`/`evaluate` from the expr packages (Tasks 1 deps).

**Risk note:** conditions-per-(contentType,action) is a documented 6C boundary (role-agnostic Spatie permissions); the exit fixture is single-role so no conflict. The gated enforcement (Task 9) is the only check that the emitted Policy + Spatie actually authorize at runtime; the local tie-in (Task 8) proves the PHP predicate logic ≡ Ring-1 without a full boot.
