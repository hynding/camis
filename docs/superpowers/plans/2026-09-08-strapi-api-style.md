# camis Phase 16 — Strapi-compatible API style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `camis build` filament target with `apiStyle: "strapi"` emits a Laravel JSON API that an existing Strapi 5 client can use unchanged: Strapi envelope and error shape, camelCase re-nested wire format, `recordId`-keyed upsert, grant-scoped lists, create-time owner assignment, Sanctum auth routes mirroring `/auth/local`, and a protected controller subclass per model.

**Architecture:** All new emitters live in a new `packages/adapter-filament/src/strapi-api/` directory and are selected by `GenerateOptions.apiStyle`; the default `"laravel"` path is untouched so every existing golden stays byte-identical. Ring 1 read conditions compile through a small `WhereNode` AST with two renderers (Eloquent PHP for generation, raw SQL for a PHP/SQLite conformance test). The CLI gains `apiStyle`, `protected`, a roles-file object form with `defaultRole`, and `camis import strapi --upsert-by`.

**Tech Stack:** TypeScript (ESM, strict, Vitest goldens via `toMatchFileSnapshot`), zod, emitted PHP 8.3 / Laravel 12 / Sanctum / Spatie. PHP-executing tests use `it.skipIf(!hasPhp())` exactly like `permissions/tie-in.test.ts`.

**Spec:** `../../../oyl/docs/superpowers/specs/2026-09-08-camis-php-oyl-design.md` (Part 1) and `docs/PLAN.md` Phase 16.

## Global Constraints

- TDD: failing test first, minimal code, refactor; red→green visible in commit history (`CLAUDE.md`).
- Codegen is deterministic: stable ordering, no timestamps; goldens byte-compared; second run = no diff.
- `apiStyle` absent or `"laravel"` ⇒ every existing golden and test passes unchanged.
- Neutral IR vocabulary outside the adapter; Strapi terms confined to `adapter-filament/src/strapi-api/` and the CLI flag.
- No `any` across package boundaries; `noUncheckedIndexedAccess` is on (index results are `T | undefined`).
- Emitted PHP is PSR-12, `declare(strict_types=1)`, generated files carry `PHP_MARKER` from `hooks/names.ts`.
- Commit messages: `feat(<package>): …` / `test(<package>): …` / `docs: …`, ending with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.
- Run `pnpm -r typecheck && pnpm -r test` before every commit; lint-staged runs on commit.

---

## File structure

**Modified**
- `packages/permissions/src/model.ts` — `assign` on `grant`; new `rolesFile` schema.
- `packages/permissions/src/validate.ts` — `IrBundle.defaultRole`; `assign` cross-checks.
- `packages/permissions/src/index.ts` — export `rolesFile`, `RolesFile`.
- `packages/adapter-kernel/src/types.ts` — `GenerateOptions.apiStyle`.
- `packages/adapter-strapi/src/import/import-document.ts`, `read-project.ts` — `upsertBy` option.
- `packages/cli/src/config.ts`, `io.ts`, `bin.ts`, `run.ts`, `commands/import.ts`, `commands/generate.ts`, `commands/scaffold.ts` — flags, roles-file object form, protected overlay, `HasApiTokens` patch.
- `packages/adapter-filament/src/permissions/project.ts` — expose `readConditions` and `assigns`.
- `packages/adapter-filament/src/generate.ts` — branch on `apiStyle`.
- `packages/adapter-filament/scripts/overlay.ts` — `--style strapi`.
- `.github/workflows/adapter-filament-boot.yml` — new `strapi-api` job.
- `packages/cli/README.md`, `docs/PLAN.md` — docs.

**Created** (all under `packages/adapter-filament/src/strapi-api/`)
- `names.ts` — `routePath(ct)`, `camelKey(column)`.
- `wire-shape.ts` — pure model of a content type's wire shape (scalars, embedded paths, child tables) shared by serializer + controller emitters.
- `serializer.ts` — `emitSerializer(shape)` → `App\Http\Serializers\<Model>Serializer`.
- `query-ast.ts` — `toWhereNode(expr, ctx)` → `WhereNode | null`.
- `render-eloquent.ts` — `renderEloquent(node)` PHP closure body.
- `render-sql.ts` — `renderSql(node, userId)` (test-only renderer).
- `scope.ts` — `emitScopeMethod(ct, condition)` → PHP `scopeForUser` + gap when falling back.
- `controller.ts` — `emitGeneratedController(...)`, `emitProtectedController(...)`.
- `routes.ts` — `emitStrapiRoutes(...)`.
- `auth.ts` — `emitAuthController(defaultRole)`, `emitUsernameMigration()`.
- `errors.ts` — `emitStrapiErrorsMiddleware()`.
- `emit.ts` — `emitStrapiApi(doc, bundle, rel, emitted)` orchestration → `GeneratedFile[]` + gaps.
- `__fixtures__/strapi-api.ts` — OYL-shaped fixture bundle.
- `__golden__/strapi-api/*` — goldens.
- `packages/adapter-filament/scripts/strapi-api-smoke.sh` — CI HTTP round trip.

---

### Task 1: `assign` on grants and the roles-file object form

**Files:**
- Modify: `packages/permissions/src/model.ts`
- Modify: `packages/permissions/src/validate.ts`
- Modify: `packages/permissions/src/index.ts`
- Test: `packages/permissions/src/model.test.ts`, `packages/permissions/src/validate.test.ts`

**Interfaces:**
- Produces: `Grant.assign?: Record<string, "user.id">`; `rolesFile` zod schema and `RolesFile = { defaultRole?: string; roles: Role[] }`; `parseRolesFile(raw: unknown): RolesFile | undefined` accepting either a bare `Role[]` or the object form; `IrBundle.defaultRole?: string`; `validateBundle` errors `unknown_assign_field` and `assign_not_user_relation`.

- [ ] **Step 1: Write the failing model tests**

Append to `packages/permissions/src/model.test.ts`:

```ts
import { grant, parseRolesFile } from "./model";

describe("grant.assign", () => {
  it("accepts assign entries whose value is user.id", () => {
    const r = grant.safeParse({
      contentType: "Note",
      actions: ["create"],
      assign: { owner: "user.id" },
    });
    expect(r.success).toBe(true);
  });
  it("rejects assign values other than user.id", () => {
    const r = grant.safeParse({ contentType: "Note", actions: ["create"], assign: { owner: "x" } });
    expect(r.success).toBe(false);
  });
});

describe("parseRolesFile", () => {
  const roles = [{ name: "authenticated", grants: [] }];
  it("accepts the bare array form with no defaultRole", () => {
    expect(parseRolesFile(roles)).toEqual({ roles });
  });
  it("accepts the object form with defaultRole", () => {
    expect(parseRolesFile({ defaultRole: "authenticated", roles })).toEqual({
      defaultRole: "authenticated",
      roles,
    });
  });
  it("returns undefined on malformed input", () => {
    expect(parseRolesFile({ roles: "nope" })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @camis/permissions test`
Expected: FAIL — `parseRolesFile` is not exported; `assign` is stripped/unknown.

- [ ] **Step 3: Implement the schema**

In `packages/permissions/src/model.ts` replace the `grant` definition and append:

```ts
export const grant = z.object({
  contentType: typeName,
  actions: z.array(action).min(1),
  fieldRules: z.array(fieldRule).optional(),
  condition: expression.optional(),
  // Create-time assignment: fill the named owning relation from the authenticated user.
  assign: z.record(fieldName, z.literal("user.id")).optional(),
});
export type Grant = z.infer<typeof grant>;

export const role = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  grants: z.array(grant),
});
export type Role = z.infer<typeof role>;

export const rolesFile = z.object({
  defaultRole: z.string().min(1).optional(),
  roles: z.array(role),
});
export type RolesFile = z.infer<typeof rolesFile>;

/** A roles file is either a bare `Role[]` (legacy) or `{ defaultRole?, roles }`. */
export const parseRolesFile = (raw: unknown): RolesFile | undefined => {
  const bare = z.array(role).safeParse(raw);
  if (bare.success) return { roles: bare.data };
  const obj = rolesFile.safeParse(raw);
  return obj.success ? obj.data : undefined;
};
```

Export from `packages/permissions/src/index.ts`: add `rolesFile`, `parseRolesFile` and type `RolesFile` alongside the existing exports.

- [ ] **Step 4: Write the failing validate tests**

Append to `packages/permissions/src/validate.test.ts` (the file's `doc` has only `Article.title`; add a second doc):

```ts
const ownedDoc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "User", kind: "collection", builtin: "user", fields: [{ type: "string", name: "username" }] },
    {
      name: "Note",
      kind: "collection",
      fields: [
        { type: "string", name: "text" },
        { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
        { type: "relation", name: "tags", relationKind: "manyToMany", target: "Note" },
      ],
    },
  ],
  components: [],
};

describe("validateBundle assign", () => {
  it("accepts assign on an owning relation to the builtin user", () => {
    const r = validateBundle({
      document: ownedDoc,
      roles: [{ name: "a", grants: [{ contentType: "Note", actions: ["create"], assign: { owner: "user.id" } }] }],
    });
    expect(r.ok).toBe(true);
  });
  it("rejects assign on an unknown field", () => {
    const r = validateBundle({
      document: ownedDoc,
      roles: [{ name: "a", grants: [{ contentType: "Note", actions: ["create"], assign: { nope: "user.id" } }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe("unknown_assign_field");
  });
  it("rejects assign on a field that is not an owning relation to the builtin user", () => {
    const r = validateBundle({
      document: ownedDoc,
      roles: [{ name: "a", grants: [{ contentType: "Note", actions: ["create"], assign: { tags: "user.id" } }] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe("assign_not_user_relation");
  });
  it("carries defaultRole through", () => {
    const r = validateBundle({ document: ownedDoc, roles: [], defaultRole: "a" });
    expect(r.ok && r.value.defaultRole).toBe("a");
  });
});
```

- [ ] **Step 5: Run to verify failure**

Run: `pnpm --filter @camis/permissions test`
Expected: FAIL — `defaultRole` not in `IrBundle`; assign errors not produced.

- [ ] **Step 6: Implement validation**

In `packages/permissions/src/validate.ts`:

```ts
export interface IrBundle {
  document: IrDocument;
  roles: Role[];
  /** Role assigned to newly registered users (Strapi API style). */
  defaultRole?: string;
}
```

Inside the `role.grants.forEach` callback, after the `fieldRules` loop, add:

```ts
      const userTypes = new Set(
        bundle.document.contentTypes.filter((c) => c.builtin === "user").map((c) => c.name),
      );
      Object.keys(grant.assign ?? {}).forEach((name) => {
        const f = ct.fields.find((x) => x.name === name);
        if (!f) {
          errors.push({
            code: "unknown_assign_field",
            message: `assign references unknown field "${grant.contentType}.${name}"`,
            location: { contentType: grant.contentType, field: name, rule: role.name },
            path: ["roles", ri, "grants", gi, "assign", name],
          });
          return;
        }
        const owning =
          f.type === "relation" &&
          (f.relationKind === "manyToOne" || f.relationKind === "oneToOne") &&
          userTypes.has(f.target);
        if (!owning) {
          errors.push({
            code: "assign_not_user_relation",
            message: `assign target "${grant.contentType}.${name}" must be a manyToOne/oneToOne relation to the builtin user type`,
            location: { contentType: grant.contentType, field: name, rule: role.name },
            path: ["roles", ri, "grants", gi, "assign", name],
          });
        }
      });
```

If `IrErrorCode` in `packages/ir-schema/src/errors.ts` is a closed union, add `"unknown_assign_field" | "assign_not_user_relation"` to it.

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm --filter @camis/permissions test && pnpm --filter @camis/permissions typecheck && pnpm --filter @camis/ir-schema test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/permissions packages/ir-schema
git commit -m "feat(permissions): grant.assign, roles-file object form with defaultRole"
```

---

### Task 2: `apiStyle` reaches the adapter; `--upsert-by` on Strapi import

**Files:**
- Modify: `packages/adapter-kernel/src/types.ts`
- Modify: `packages/adapter-strapi/src/import/import-document.ts`, `packages/adapter-strapi/src/import/read-project.ts`
- Modify: `packages/cli/src/config.ts`, `packages/cli/src/run.ts`, `packages/cli/src/commands/import.ts`
- Test: `packages/adapter-strapi/src/import/import-document.test.ts`, `packages/cli/src/config.test.ts`, `packages/cli/src/commands/import.test.ts`

**Interfaces:**
- Produces: `GenerateOptions.apiStyle?: "laravel" | "strapi"`; `TargetConfig.apiStyle`; `ProjectConfig.protected?: string` (absolute, resolved); `importDocument(files, opts?: { upsertBy?: string })`; `readStrapiProject(dir, opts?)`; CLI `camis import strapi <dir> --upsert-by <field>`.

- [ ] **Step 1: Failing importer test**

Append to `packages/adapter-strapi/src/import/import-document.test.ts`:

```ts
describe("importDocument upsertBy", () => {
  const note = JSON.stringify({
    kind: "collectionType",
    collectionName: "notes",
    info: { singularName: "note", pluralName: "notes", displayName: "Note" },
    attributes: {
      recordId: { type: "string", required: true, unique: true },
      text: { type: "text" },
    },
  });
  const tag = JSON.stringify({
    kind: "collectionType",
    collectionName: "tags",
    info: { singularName: "tag", pluralName: "tags", displayName: "Tag" },
    attributes: { label: { type: "string" } },
  });
  const files = [
    { path: "src/api/note/content-types/note/schema.json", content: note },
    { path: "src/api/tag/content-types/tag/schema.json", content: tag },
  ];
  it("sets options.upsertBy only on types that have that unique field", () => {
    const r = importDocument(files, { upsertBy: "recordId" }).document;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byName = new Map(r.value.contentTypes.map((c) => [c.name, c]));
    expect(byName.get("Note")?.options?.upsertBy).toBe("recordId");
    expect(byName.get("Tag")?.options?.upsertBy).toBeUndefined();
  });
  it("leaves options untouched without the option", () => {
    const r = importDocument(files).document;
    expect(r.ok && r.value.contentTypes[0]?.options?.upsertBy).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @camis/adapter-strapi test -- import-document`
Expected: FAIL — second argument ignored / type error.

- [ ] **Step 3: Implement the option**

In `import-document.ts`:

```ts
export interface ImportOptions {
  /** Set `options.upsertBy` on every content type carrying a unique field of this name. */
  upsertBy?: string;
}

export const importDocument = (
  files: { path: string; content: string }[],
  opts: ImportOptions = {},
): { document: Result<IrDocument>; gaps: CapabilityGapReport } => {
```

After the file loop and before the builtin-user push:

```ts
  if (opts.upsertBy !== undefined) {
    for (const ct of contentTypes) {
      const f = ct.fields.find((x) => x.name === opts.upsertBy);
      const unique = f !== undefined && (f as { unique?: boolean }).unique === true;
      if (unique) ct.options = { ...(ct.options ?? {}), upsertBy: opts.upsertBy };
    }
  }
```

In `read-project.ts`, thread it: `readStrapiProject(dir: string, opts: ImportOptions = {})` → `return importDocument(files, opts);` and export `ImportOptions` from `packages/adapter-strapi/src/index.ts`.

- [ ] **Step 4: Failing CLI config + import tests**

Append to `packages/cli/src/config.test.ts` (follow the file's existing `loadConfig` test style with a fake `Io`):

```ts
  it("accepts apiStyle on a target and resolves protected relative to the config", async () => {
    const io = fakeIo({
      "/p/camis.config.json": JSON.stringify({
        ir: "./camis.json",
        protected: "./overlay",
        targets: [{ target: "filament", out: "./laravel", apiStyle: "strapi" }],
      }),
    });
    const r = await loadConfig(io, "camis.config.json");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.protected).toBe("/p/overlay");
    expect(r.value.targets[0]?.apiStyle).toBe("strapi");
  });
  it("rejects an unknown apiStyle", async () => {
    const io = fakeIo({
      "/p/camis.config.json": JSON.stringify({
        ir: "./camis.json",
        targets: [{ target: "filament", out: "./laravel", apiStyle: "graphql" }],
      }),
    });
    expect((await loadConfig(io, "camis.config.json")).ok).toBe(false);
  });
```

(If `config.test.ts` has no `fakeIo` helper, define one in the test: `readFile` resolves from the map, other members are no-op stubs, `cwd: "/p"`.)

Append to `packages/cli/src/commands/import.test.ts`:

```ts
  it("passes --upsert-by through to the Strapi importer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "camis-import-"));
    await mkdir(join(dir, "src/api/note/content-types/note"), { recursive: true });
    await writeFile(
      join(dir, "src/api/note/content-types/note/schema.json"),
      JSON.stringify({
        kind: "collectionType",
        collectionName: "notes",
        info: { singularName: "note", pluralName: "notes", displayName: "Note" },
        attributes: { recordId: { type: "string", unique: true } },
      }),
    );
    const lines: string[] = [];
    const written: Record<string, string> = {};
    const code = await importCommand("strapi", dir, "/p/out.json", memIo({}, lines, written), {
      upsertBy: "recordId",
    });
    expect(code).toBe(0);
    expect(JSON.parse(written["/p/out.json"]!).contentTypes[0].options.upsertBy).toBe("recordId");
  });
```

(Add `mkdir` to the existing `node:fs/promises` import.)

- [ ] **Step 5: Run to verify failure**

Run: `pnpm --filter @camis/cli test`
Expected: FAIL — unknown keys / extra argument.

- [ ] **Step 6: Implement CLI plumbing**

`packages/adapter-kernel/src/types.ts`:

```ts
export type ApiStyle = "laravel" | "strapi";

export interface GenerateOptions {
  projectName: string;
  /** Filament only: shape of the generated JSON API. Default "laravel". */
  apiStyle?: ApiStyle;
}
```

Export `ApiStyle` from `packages/adapter-kernel/src/index.ts`.

`packages/cli/src/config.ts`:

```ts
export const targetConfig = z.object({
  target: z.enum(["express", "strapi", "filament"]),
  out: z.string().min(1),
  projectName: z.string().optional(),
  dialect: z.enum(["sqlite", "mysql", "pgsql"]).optional(),
  apiStyle: z.enum(["laravel", "strapi"]).optional(),
});

export const projectConfig = z.object({
  ir: z.string().min(1),
  roles: z.string().min(1).optional(),
  /** Directory mirrored into every target's `out` after generation (hand-written seams). */
  protected: z.string().min(1).optional(),
  targets: z.array(targetConfig).min(1),
});
```

and in `loadConfig`'s `value`: `...(parsed.data.protected !== undefined ? { protected: resolve(base, parsed.data.protected) } : {}),`.

`packages/cli/src/commands/import.ts`: add a 5th parameter `opts: { upsertBy?: string } = {}` and call `readStrapiProject(dir, opts)`.

`packages/cli/src/run.ts`: in the `import` case:

```ts
      const upsertBy = flag(rest, "--upsert-by", "");
      return importCommand(rest[0], rest[1], flag(rest, "--out", "camis.json"), io, {
        ...(upsertBy ? { upsertBy } : {}),
      });
```

and update `USAGE`: `camis import <strapi|express> <projectDir> [--out ir.json] [--upsert-by <field>]`.

- [ ] **Step 7: Run all tests + typecheck**

Run: `pnpm -r typecheck && pnpm -r test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/adapter-kernel packages/adapter-strapi packages/cli
git commit -m "feat(cli,adapter-strapi): apiStyle + protected config, import --upsert-by"
```

---

### Task 3: CLI roles-file object form, `defaultRole`, `apiStyle` pass-through, protected overlay mirroring

**Files:**
- Modify: `packages/cli/src/io.ts`, `packages/cli/src/bin.ts`, `packages/cli/src/commands/generate.ts`
- Test: `packages/cli/src/commands/generate.test.ts`

**Interfaces:**
- Consumes: `parseRolesFile` (Task 1), `ProjectConfig.protected`, `TargetConfig.apiStyle` (Task 2).
- Produces: `Io.copyDir(src: string, dest: string): Promise<void>`; `generateCommand` calls `adapter.generate({ document, roles, defaultRole }, { projectName, apiStyle })` and, when `protected` is set and `write` is true, `io.copyDir(protected, t.out)` after `materialize`.

- [ ] **Step 1: Failing tests**

Append to `packages/cli/src/commands/generate.test.ts`. Extend the file's `io()` helper so it accepts a files map and a `copyDir` spy:

```ts
const rolesObj = JSON.stringify({
  defaultRole: "authenticated",
  roles: [{ name: "authenticated", grants: [{ contentType: "Article", actions: ["read"] }] }],
});
const filamentConfig = JSON.stringify({
  ir: "./camis.json",
  roles: "./roles.json",
  protected: "./overlay",
  targets: [{ target: "filament", out: "./laravel", apiStyle: "strapi" }],
});
const plainIr = JSON.stringify({
  version: 1,
  contentTypes: [{ name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] }],
  components: [],
});

describe("generateCommand strapi style", () => {
  const files: Record<string, string> = {
    "/p/camis.config.json": filamentConfig,
    "/p/camis.json": plainIr,
    "/p/roles.json": rolesObj,
  };
  const mk = (lines: string[], materializeSpy = vi.fn(() => Promise.resolve()), copySpy = vi.fn(() => Promise.resolve())): Io => ({
    readFile: (p) => (p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error(`ENOENT ${p}`))),
    writeFile: () => Promise.resolve(),
    materialize: materializeSpy,
    copyDir: copySpy,
    exec: () => Promise.resolve(0),
    out: (l) => lines.push(l),
    cwd: "/p",
  });
  it("accepts the roles-file object form and emits the Strapi-style auth controller", async () => {
    const lines: string[] = [];
    const spy = vi.fn(() => Promise.resolve()) as MockedFunction<(r: GenerationResult, d: string) => Promise<void>>;
    const code = await generateCommand("camis.config.json", mk(lines, spy), { write: true });
    expect(code).toBe(0);
    const paths = spy.mock.calls[0]![0].files.map((f) => f.path);
    expect(paths).toContain("app/Http/Controllers/Api/AuthController.php");
  });
  it("mirrors the protected directory into out after materializing", async () => {
    const lines: string[] = [];
    const copy = vi.fn(() => Promise.resolve());
    await generateCommand("camis.config.json", mk(lines, undefined, copy), { write: true });
    expect(copy).toHaveBeenCalledWith("/p/overlay", "/p/laravel");
  });
  it("does not copy on dry-run", async () => {
    const copy = vi.fn(() => Promise.resolve());
    await generateCommand("camis.config.json", mk([], undefined, copy), { write: false });
    expect(copy).not.toHaveBeenCalled();
  });
});
```

Every other `Io` literal in the CLI tests needs `copyDir: () => Promise.resolve()` added (the interface gains a required member).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @camis/cli test`
Expected: FAIL — `copyDir` missing; roles object form rejected; `AuthController.php` absent (the emitter arrives in Task 9; this assertion stays red until then — that is expected, note it in the commit).

- [ ] **Step 3: Implement**

`packages/cli/src/io.ts` — add to the interface:

```ts
  /** Recursively copy a directory tree, overwriting files that already exist. */
  copyDir(src: string, dest: string): Promise<void>;
```

`packages/cli/src/bin.ts` — import `cp` from `node:fs/promises` and add `copyDir: (s, d) => cp(s, d, { recursive: true, force: true }),`.

`packages/cli/src/commands/generate.ts` — replace the roles block and the target loop:

```ts
import { parseRolesFile, validateBundle, type Role } from "@camis/permissions";
// …
  let roles: Role[] = [];
  let defaultRole: string | undefined;
  if (cfg.value.roles !== undefined) {
    let rolesRaw: unknown;
    try {
      rolesRaw = JSON.parse(await io.readFile(cfg.value.roles));
    } catch (e) {
      io.out(`✗ cannot read roles ${cfg.value.roles}: ${(e as Error).message}`);
      return 1;
    }
    const parsed = parseRolesFile(rolesRaw);
    if (!parsed) {
      io.out(`✗ roles: expected a Role[] or { defaultRole?, roles: Role[] }`);
      return 1;
    }
    const bundle = validateBundle({
      document,
      roles: parsed.roles,
      ...(parsed.defaultRole !== undefined ? { defaultRole: parsed.defaultRole } : {}),
    });
    if (!bundle.ok) {
      for (const e of bundle.errors) io.out(`✗ [${e.code}] ${locStr(e.location)} — ${e.message}`);
      return 1;
    }
    roles = bundle.value.roles;
    defaultRole = bundle.value.defaultRole;
  }

  let exit = 0;
  for (const t of cfg.value.targets) {
    const projectName = t.projectName ?? basename(t.out);
    const result = adapterFor(t).generate(
      { document, roles, ...(defaultRole !== undefined ? { defaultRole } : {}) },
      { projectName, ...(t.apiStyle !== undefined ? { apiStyle: t.apiStyle } : {}) },
    );
    const errorGap = printGaps(io, result.gaps.gaps);
    if (errorGap) {
      io.out(`✗ ${t.target}: aborted — unrepresentable feature (error gap)`);
      exit = 1;
      continue;
    }
    if (opts.write) {
      await io.materialize(result, t.out);
      if (cfg.value.protected !== undefined) {
        await io.copyDir(cfg.value.protected, t.out);
        io.out(`✓ ${t.target}: mirrored ${cfg.value.protected} → ${t.out}`);
      }
      io.out(`✓ ${t.target}: wrote ${result.files.length} files → ${t.out}`);
    } else {
      io.out(`${t.target}: ${result.files.length} files → ${t.out} (dry-run)`);
    }
  }
  return exit;
```

Remove the now-unused `z` and `role` imports if nothing else uses them.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @camis/cli test && pnpm -r typecheck`
Expected: all PASS except the `AuthController.php` assertion (red until Task 9).

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): roles-file object form, defaultRole, apiStyle pass-through, protected overlay mirror"
```

---

### Task 4: Strapi-API names and the wire-shape model

**Files:**
- Create: `packages/adapter-filament/src/strapi-api/names.ts`
- Create: `packages/adapter-filament/src/strapi-api/wire-shape.ts`
- Create: `packages/adapter-filament/src/strapi-api/__fixtures__/strapi-api.ts`
- Test: `packages/adapter-filament/src/strapi-api/names.test.ts`, `packages/adapter-filament/src/strapi-api/wire-shape.test.ts`

**Interfaces:**
- Produces:
  - `routePath(ct: ContentType): string` — kebab of `ct.names?.plural ?? pluralize(ct.name)` (e.g. `ActivitySessions` → `activity-sessions`).
  - `camelKey(fieldName: string): string` — identity for IR names (they are already camelCase); exists so every wire key goes through one function.
  - `wireShape(doc, ct, fkNames): WireShape` where

    ```ts
    export interface WireScalar { key: string[]; column: string; type: FieldType }         // key = wire path segments
    export interface WireChild  { key: string; relation: string; model: string; scalars: WireScalar[] }
    export interface WireShape  { model: string; keyColumn: "id" | string; scalars: WireScalar[]; children: WireChild[] }
    ```
    `keyColumn` is `snakeColumn(ct.options.upsertBy)` or `"id"`. Relation FKs are **not** in `scalars`. Top-level scalars have a one-segment `key`; embedded component scalars carry the full path (`["amount","minor"]` → column `amount_minor`).
  - Fixture `strapiApiBundle: IrBundle` — see Step 3.

- [ ] **Step 1: Failing tests**

`names.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { camelKey, routePath } from "./names";

describe("strapi-api names", () => {
  it("routePath is the kebab plural from names.plural", () => {
    expect(
      routePath({ name: "ActivitySession", kind: "collection", names: { plural: "ActivitySessions" }, fields: [] }),
    ).toBe("activity-sessions");
  });
  it("routePath falls back to pluralizing the type name", () => {
    expect(routePath({ name: "Note", kind: "collection", fields: [] })).toBe("notes");
    expect(routePath({ name: "Category", kind: "collection", fields: [] })).toBe("categories");
  });
  it("camelKey preserves IR field names", () => {
    expect(camelKey("recordId")).toBe("recordId");
  });
});
```

`wire-shape.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { wireShape } from "./wire-shape";

const doc = normalize(strapiApiBundle.document);
const ct = (name: string) => doc.contentTypes.find((c) => c.name === name)!;

describe("wireShape", () => {
  it("maps top-level scalars, skips relations, uses upsertBy as key column", () => {
    const s = wireShape(doc, ct("Note"), ["owner_id"]);
    expect(s.model).toBe("Note");
    expect(s.keyColumn).toBe("record_id");
    expect(s.scalars.map((x) => x.key.join("."))).toEqual(["recordId", "text", "tags", "occurredAt"]);
    expect(s.scalars.find((x) => x.column === "owner_id")).toBeUndefined();
  });
  it("embeds non-repeatable components as nested keys over prefixed columns", () => {
    const s = wireShape(doc, ct("Transaction"), ["owner_id"]);
    const minor = s.scalars.find((x) => x.column === "amount_minor")!;
    expect(minor.key).toEqual(["amount", "minor"]);
    expect(minor.type).toBe("bigInteger");
  });
  it("realizes repeatable components as children", () => {
    const s = wireShape(doc, ct("ActivitySession"), ["owner_id"]);
    expect(s.children).toHaveLength(1);
    expect(s.children[0]).toMatchObject({ key: "quantities", relation: "quantities", model: "ActivitySessionQuantities" });
    expect(s.children[0]!.scalars.map((x) => x.column)).toEqual(["amount", "unit"]);
  });
  it("uses id as the key column without upsertBy", () => {
    expect(wireShape(doc, ct("Tag"), []).keyColumn).toBe("id");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @camis/adapter-filament test -- strapi-api`
Expected: FAIL — modules missing.

- [ ] **Step 3: Write the fixture**

`packages/adapter-filament/src/strapi-api/__fixtures__/strapi-api.ts` — an OYL-shaped bundle (small, but covers every shape the serializer must invert):

```ts
import type { IrBundle } from "@camis/permissions";

const ownerEq = { kind: "eq", left: { kind: "var", name: "record.ownerId" }, right: { kind: "var", name: "user.id" } } as const;
const publicOrMine = {
  kind: "or",
  args: [
    { kind: "eq", left: { kind: "var", name: "record.visibility" }, right: { kind: "lit", value: "public" } },
    { kind: "eq", left: { kind: "var", name: "record.creatorId" }, right: { kind: "var", name: "user.id" } },
  ],
} as const;

export const strapiApiBundle: IrBundle = {
  defaultRole: "authenticated",
  document: {
    version: 1,
    contentTypes: [
      { name: "User", kind: "collection", builtin: "user", fields: [
        { type: "string", name: "username", required: true, unique: true },
        { type: "email", name: "email", required: true },
      ] },
      { name: "Note", kind: "collection", names: { plural: "Notes" }, options: { upsertBy: "recordId" }, fields: [
        { type: "string", name: "recordId", required: true, unique: true },
        { type: "text", name: "text", required: true },
        { type: "json", name: "tags" },
        { type: "dateTime", name: "occurredAt", required: true },
        { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
      ] },
      { name: "Transaction", kind: "collection", names: { plural: "Transactions" }, options: { upsertBy: "recordId" }, fields: [
        { type: "string", name: "recordId", required: true, unique: true },
        { type: "component", name: "amount", component: "Money", repeatable: false },
        { type: "decimal", name: "fee" },
        { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
      ] },
      { name: "ActivitySession", kind: "collection", names: { plural: "ActivitySessions" }, options: { upsertBy: "recordId" }, fields: [
        { type: "string", name: "recordId", required: true, unique: true },
        { type: "component", name: "quantities", component: "Quantity", repeatable: true },
        { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
      ] },
      { name: "Activity", kind: "collection", names: { plural: "Activities" }, options: { upsertBy: "recordId" }, fields: [
        { type: "string", name: "recordId", required: true, unique: true },
        { type: "string", name: "name", required: true },
        { type: "enumeration", name: "visibility", values: ["private", "public"], default: "public" },
        { type: "relation", name: "creator", relationKind: "manyToOne", target: "User" },
      ] },
      { name: "Tag", kind: "collection", fields: [{ type: "string", name: "label" }] },
    ],
    components: [
      { name: "Money", fields: [{ type: "bigInteger", name: "minor" }, { type: "string", name: "currency" }] },
      { name: "Quantity", fields: [{ type: "decimal", name: "amount" }, { type: "string", name: "unit" }] },
    ],
  },
  roles: [
    {
      name: "authenticated",
      grants: [
        { contentType: "Note", actions: ["create", "read", "update", "delete"], condition: ownerEq, assign: { owner: "user.id" } },
        { contentType: "Transaction", actions: ["create", "read", "update", "delete"], condition: ownerEq, assign: { owner: "user.id" } },
        { contentType: "ActivitySession", actions: ["create", "read", "update", "delete"], condition: ownerEq, assign: { owner: "user.id" } },
        { contentType: "Activity", actions: ["create", "read", "update", "delete"], condition: publicOrMine, assign: { creator: "user.id" } },
        { contentType: "Tag", actions: ["read"] },
      ],
    },
  ],
};
```

(If the `enumeration` field's `values`/`default` keys differ in `ir-schema/src/fields.ts`, match that file.)

- [ ] **Step 4: Implement names and wire-shape**

`names.ts`:

```ts
import type { ContentType } from "@camis/ir-schema";
import { pluralize } from "@camis/ir-core";

const kebab = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase();

/** Strapi REST path segment: kebab-case plural (`ActivitySessions` → `activity-sessions`). */
export const routePath = (ct: ContentType): string => kebab(ct.names?.plural ?? pluralize(ct.name));

/** Wire keys are the IR field names (already camelCase); one seam for all of them. */
export const camelKey = (fieldName: string): string => fieldName;
```

`wire-shape.ts`:

```ts
import { expandComponents } from "@camis/adapter-kernel";
import type { ContentType, FieldType, IrDocument } from "@camis/ir-schema";
import { childTableEmit } from "../components";
import { filamentNames, snakeColumn } from "../names";
import { camelKey } from "./names";

export interface WireScalar { key: string[]; column: string; type: FieldType }
export interface WireChild { key: string; relation: string; model: string; scalars: WireScalar[] }
export interface WireShape { model: string; keyColumn: string; scalars: WireScalar[]; children: WireChild[] }

export const wireShape = (doc: IrDocument, ct: ContentType, _fkNames: string[]): WireShape => {
  const names = filamentNames(ct);
  const expansion = expandComponents(doc, ct);
  const top: WireScalar[] = ct.fields
    .filter((f) => f.type !== "relation" && f.type !== "component")
    .map((f) => ({ key: [camelKey(f.name)], column: snakeColumn(f.name), type: f.type }));
  const embedded: WireScalar[] = expansion.scalars.map((s) => ({
    key: s.path.map(camelKey),
    column: s.path.map(snakeColumn).join("_"),
    type: s.field.type,
  }));
  const children: WireChild[] = expansion.tables.map((t) => {
    const child = childTableEmit(ct, t);
    return {
      key: camelKey(t.path.join(".")),
      relation: child.relationName,
      model: child.model,
      scalars: t.scalars.map((s) => ({
        key: s.path.map(camelKey),
        column: s.path.map(snakeColumn).join("_"),
        type: s.field.type,
      })),
    };
  });
  const upsertBy = ct.options?.upsertBy;
  return {
    model: names.model,
    keyColumn: upsertBy !== undefined ? snakeColumn(upsertBy) : "id",
    scalars: [...top, ...embedded],
    children,
  };
};
```

(`_fkNames` is accepted for signature stability with the controller emitter; relations are excluded by construction.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @camis/adapter-filament test -- strapi-api && pnpm --filter @camis/adapter-filament typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-filament/src/strapi-api
git commit -m "feat(adapter-filament): strapi-api names + wire-shape model with OYL-shaped fixture"
```

---

### Task 5: Serializer emitter

**Files:**
- Create: `packages/adapter-filament/src/strapi-api/serializer.ts`
- Test: `packages/adapter-filament/src/strapi-api/serializer.test.ts`
- Golden: `packages/adapter-filament/src/strapi-api/__golden__/strapi-api/TransactionSerializer.php`, `ActivitySessionSerializer.php`

**Interfaces:**
- Consumes: `WireShape` (Task 4).
- Produces: `emitSerializer(shape: WireShape): string` — PHP class `App\Http\Serializers\<Model>Serializer` with
  - `public static function toWire(<Model> $m): array` — camelCase keys, nested components, child arrays, nulls omitted at every level, numbers cast, datetimes via `->toJSON()`, plus `id`, `createdAt`, `updatedAt`.
  - `public static function fromWire(array $data): array` — returns `['columns' => array, 'children' => array<string, list<array>>]`.
  - `public static function syncChildren(<Model> $m, array $children): void` — delete + re-insert each child relation.

- [ ] **Step 1: Failing golden tests**

```ts
import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { emitSerializer } from "./serializer";
import { wireShape } from "./wire-shape";

const doc = normalize(strapiApiBundle.document);
const shape = (name: string) => wireShape(doc, doc.contentTypes.find((c) => c.name === name)!, ["owner_id"]);

describe("emitSerializer", () => {
  it("Transaction serializer golden (embedded component + decimal + bigInteger)", async () => {
    await expect(emitSerializer(shape("Transaction"))).toMatchFileSnapshot(
      "./__golden__/strapi-api/TransactionSerializer.php",
    );
  });
  it("ActivitySession serializer golden (repeatable child)", async () => {
    await expect(emitSerializer(shape("ActivitySession"))).toMatchFileSnapshot(
      "./__golden__/strapi-api/ActivitySessionSerializer.php",
    );
  });
  it("omits nulls via the shared helper and never emits relation FKs", () => {
    const php = emitSerializer(shape("Note"));
    expect(php).toContain("self::omitNulls(");
    expect(php).not.toContain("owner_id");
    expect(php).toContain("'occurredAt' => $m->occurred_at?->toJSON()");
    expect(php).toContain("'createdAt' => $m->created_at?->toJSON()");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @camis/adapter-filament test -- serializer`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`serializer.ts`:

```ts
import { PHP_MARKER } from "../hooks/names";
import type { WireChild, WireScalar, WireShape } from "./wire-shape";

const NUMERIC_INT = new Set(["integer", "bigInteger"]);
const NUMERIC_FLOAT = new Set(["float", "decimal"]);
const DATETIME = new Set(["dateTime", "timestamp", "date"]);

// PHP expression producing the wire value for one column of `$src`.
const read = (s: WireScalar, src: string): string => {
  const col = `${src}->${s.column}`;
  if (NUMERIC_INT.has(s.type)) return `${col} === null ? null : (int) ${col}`;
  if (NUMERIC_FLOAT.has(s.type)) return `${col} === null ? null : (float) ${col}`;
  if (DATETIME.has(s.type)) return `${col}?->toJSON()`;
  return col;
};

// Build a nested PHP array literal from scalars whose keys are paths.
interface Node { leaves: Map<string, string>; branches: Map<string, Node> }
const node = (): Node => ({ leaves: new Map(), branches: new Map() });
const insert = (root: Node, key: string[], expr: string): void => {
  let cur = root;
  key.slice(0, -1).forEach((seg) => {
    let next = cur.branches.get(seg);
    if (!next) { next = node(); cur.branches.set(seg, next); }
    cur = next;
  });
  cur.leaves.set(key[key.length - 1]!, expr);
};
const render = (n: Node, indent: string): string => {
  const rows: string[] = [];
  for (const [k, v] of n.leaves) rows.push(`${indent}'${k}' => ${v},`);
  for (const [k, b] of n.branches) rows.push(`${indent}'${k}' => self::omitNulls([\n${render(b, `${indent}    `)}\n${indent}]),`);
  return rows.join("\n");
};

const toWireBody = (shape: WireShape): string => {
  const root = node();
  insert(root, ["id"], "$m->id");
  for (const s of shape.scalars) insert(root, s.key, read(s, "$m"));
  for (const c of shape.children) {
    const inner = node();
    for (const s of c.scalars) insert(inner, s.key, read(s, "$c"));
    insert(root, [c.key], `$m->${c.relation}->map(fn ($c) => self::omitNulls([\n${render(inner, "            ")}\n        ]))->values()->all()`);
  }
  insert(root, ["createdAt"], "$m->created_at?->toJSON()");
  insert(root, ["updatedAt"], "$m->updated_at?->toJSON()");
  return render(root, "            ");
};

const fromWireColumns = (scalars: WireScalar[], src: string): string =>
  scalars
    .map((s) => `            '${s.column}' => self::dig(${src}, [${s.key.map((k) => `'${k}'`).join(", ")}]),`)
    .join("\n");

const fromWireChildren = (children: WireChild[]): string =>
  children
    .map(
      (c) => `            '${c.relation}' => array_map(fn (array $row) => array_filter([
${fromWireColumns(c.scalars, "$row")}
            ], fn ($v) => $v !== null), is_array($data['${c.key}'] ?? null) ? $data['${c.key}'] : []),`,
    )
    .join("\n");

const syncBody = (children: WireChild[]): string =>
  children
    .map(
      (c) => `        if (array_key_exists('${c.relation}', $children)) {
            $m->${c.relation}()->delete();
            $m->${c.relation}()->createMany($children['${c.relation}']);
        }`,
    )
    .join("\n");

export const emitSerializer = (shape: WireShape): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Serializers;

use App\\Models\\${shape.model};

final class ${shape.model}Serializer
{
    /** Strapi-shaped wire object: camelCase keys, nested components, nulls omitted. */
    public static function toWire(${shape.model} $m): array
    {
        return self::omitNulls([
${toWireBody(shape)}
        ]);
    }

    /** Inverse of toWire: ['columns' => [...], 'children' => [relation => list<row>]]. Unknown keys ignored. */
    public static function fromWire(array $data): array
    {
        $columns = array_filter([
${fromWireColumns(shape.scalars, "$data")}
        ], fn ($v) => $v !== null);
        $children = [
${fromWireChildren(shape.children)}
        ];

        return ['columns' => $columns, 'children' => $children];
    }

    public static function syncChildren(${shape.model} $m, array $children): void
    {
${syncBody(shape.children)}
    }

    private static function omitNulls(array $a): array
    {
        return array_filter($a, fn ($v) => $v !== null);
    }

    private static function dig(array $a, array $path): mixed
    {
        $cur = $a;
        foreach ($path as $seg) {
            if (! is_array($cur) || ! array_key_exists($seg, $cur)) {
                return null;
            }
            $cur = $cur[$seg];
        }

        return $cur;
    }
}
`;
```

Notes for the implementer: `array_filter` with a callback preserves keys, which is what we want for associative arrays; child rows go through `->values()` so lists stay lists in JSON. Omitting nulls means a client that sends `"note": null` clears nothing — that matches Strapi-oyl's `?? null` defaulting only for create; for update the client always sends the full record, so this is acceptable and documented in the class docblock.

- [ ] **Step 4: Run tests; inspect the written goldens by eye**

Run: `pnpm --filter @camis/adapter-filament test -- serializer`
Expected: PASS (first run writes the two golden files). Open `__golden__/strapi-api/TransactionSerializer.php` and confirm `'amount' => self::omitNulls([ 'minor' => …(int)…, 'currency' => … ])` and `'fee' => … (float) …`. Run again to confirm no diff.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-filament/src/strapi-api
git commit -m "feat(adapter-filament): strapi-api serializer emitter (toWire/fromWire/syncChildren)"
```

---

### Task 6: Ring 1 → `WhereNode` AST with Eloquent and SQL renderers + PHP/SQLite conformance

**Files:**
- Create: `packages/adapter-filament/src/strapi-api/query-ast.ts`, `render-eloquent.ts`, `render-sql.ts`
- Test: `packages/adapter-filament/src/strapi-api/query-ast.test.ts`, `packages/adapter-filament/src/strapi-api/query-conformance.test.ts`

**Interfaces:**
- Produces:

  ```ts
  export type WhereValue = { kind: "lit"; value: string | number | boolean | null } | { kind: "userId" };
  export type WhereNode =
    | { kind: "eq"; column: string; value: WhereValue }
    | { kind: "and" | "or"; args: WhereNode[] };
  export interface WhereContext { columns: Map<string, { column: string; type: FieldType }> } // "record.status" → status; "record.ownerId" → owner_id
  export const toWhereNode = (expr: Expression, ctx: WhereContext): WhereNode | null;   // null ⇒ unsupported → caller falls back
  export const renderEloquent = (node: WhereNode, q: string, user: string): string;      // PHP statements against Builder `$q`
  export const renderSql = (node: WhereNode, userId: number): string;                    // test-only SQL WHERE body
  export const whereContext = (ct: ContentType): WhereContext;
  ```

  Supported: `eq` whose one side is `var record.*` and the other is `lit` or `var user.id`, with a statically type-compatible pair (string column ↔ string lit, numeric column ↔ number lit or `user.id`, boolean ↔ boolean, any column ↔ null); `and`/`or` of supported nodes. Everything else returns `null`.

- [ ] **Step 1: Failing AST tests**

```ts
import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { renderEloquent, renderSql, toWhereNode, whereContext } from "./query-ast";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

const activity = strapiApiBundle.document.contentTypes.find((c) => c.name === "Activity")!;
const ctx = whereContext(activity);
const v = (name: string): Expression => ({ kind: "var", name });
const lit = (value: string | number | boolean | null): Expression => ({ kind: "lit", value });

describe("toWhereNode", () => {
  it("compiles record.field == literal", () => {
    expect(toWhereNode({ kind: "eq", left: v("record.visibility"), right: lit("public") }, ctx)).toEqual({
      kind: "eq", column: "visibility", value: { kind: "lit", value: "public" },
    });
  });
  it("compiles record.<relation>Id == user.id (either operand order)", () => {
    const n = { kind: "eq", column: "creator_id", value: { kind: "userId" } };
    expect(toWhereNode({ kind: "eq", left: v("record.creatorId"), right: v("user.id") }, ctx)).toEqual(n);
    expect(toWhereNode({ kind: "eq", left: v("user.id"), right: v("record.creatorId") }, ctx)).toEqual(n);
  });
  it("compiles or/and recursively", () => {
    const e: Expression = { kind: "or", args: [
      { kind: "eq", left: v("record.visibility"), right: lit("public") },
      { kind: "eq", left: v("record.creatorId"), right: v("user.id") },
    ] };
    expect(toWhereNode(e, ctx)?.kind).toBe("or");
  });
  it("returns null for ne, not, lt, record-vs-record, user.email, and type mismatches", () => {
    expect(toWhereNode({ kind: "ne", left: v("record.visibility"), right: lit("public") }, ctx)).toBeNull();
    expect(toWhereNode({ kind: "not", arg: { kind: "eq", left: v("record.visibility"), right: lit("public") } }, ctx)).toBeNull();
    expect(toWhereNode({ kind: "lt", left: v("record.creatorId"), right: lit(3) }, ctx)).toBeNull();
    expect(toWhereNode({ kind: "eq", left: v("record.name"), right: v("record.visibility") }, ctx)).toBeNull();
    expect(toWhereNode({ kind: "eq", left: v("record.name"), right: v("user.email") }, ctx)).toBeNull();
    expect(toWhereNode({ kind: "eq", left: v("record.visibility"), right: lit(1) }, ctx)).toBeNull();
  });
});

describe("renderers", () => {
  const node = toWhereNode({ kind: "or", args: [
    { kind: "eq", left: v("record.visibility"), right: lit("public") },
    { kind: "eq", left: v("record.creatorId"), right: v("user.id") },
  ] }, ctx)!;
  it("renderEloquent nests closures", () => {
    expect(renderEloquent(node, "$q", "$user")).toBe(
      "$q->where(function ($q) use ($user) { $q->where('visibility', '=', 'public'); $q->orWhere('creator_id', '=', $user->id); });",
    );
  });
  it("renderSql produces a parenthesized WHERE body", () => {
    expect(renderSql(node, 7)).toBe("((visibility = 'public') OR (creator_id = 7))");
  });
  it("null literals render as IS NULL", () => {
    const n = toWhereNode({ kind: "eq", left: v("record.name"), right: lit(null) }, ctx)!;
    expect(renderEloquent(n, "$q", "$user")).toBe("$q->whereNull('name');");
    expect(renderSql(n, 1)).toBe("(name IS NULL)");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @camis/adapter-filament test -- query-ast`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the AST**

`query-ast.ts`:

```ts
import type { Expression } from "@camis/expr";
import type { ContentType, FieldType } from "@camis/ir-schema";
import { snakeColumn } from "../names";
export { renderEloquent } from "./render-eloquent";
export { renderSql } from "./render-sql";

export type WhereValue = { kind: "lit"; value: string | number | boolean | null } | { kind: "userId" };
export type WhereNode =
  | { kind: "eq"; column: string; value: WhereValue }
  | { kind: "and" | "or"; args: WhereNode[] };

export interface WhereContext {
  columns: Map<string, { column: string; type: FieldType }>;
}

const NUMERIC = new Set<FieldType>(["integer", "bigInteger", "float", "decimal"]);
const STRINGY = new Set<FieldType>(["string", "text", "richText", "email", "uid", "enumeration", "date", "time", "dateTime", "timestamp"]);

export const whereContext = (ct: ContentType): WhereContext => {
  const columns = new Map<string, { column: string; type: FieldType }>();
  for (const f of ct.fields) {
    if (f.type === "relation") {
      if (f.relationKind === "manyToOne" || f.relationKind === "oneToOne") {
        columns.set(`record.${f.name}Id`, { column: `${snakeColumn(f.name)}_id`, type: "integer" });
      }
      continue;
    }
    if (f.type === "component") continue;
    columns.set(`record.${f.name}`, { column: snakeColumn(f.name), type: f.type });
  }
  return { columns };
};

const compatible = (type: FieldType, value: WhereValue): boolean => {
  if (value.kind === "userId") return NUMERIC.has(type);
  const v = value.value;
  if (v === null) return true;
  if (typeof v === "number") return NUMERIC.has(type);
  if (typeof v === "boolean") return type === "boolean";
  return STRINGY.has(type);
};

const operand = (e: Expression, ctx: WhereContext): { column: string; type: FieldType } | WhereValue | null => {
  if (e.kind === "lit") return { kind: "lit", value: e.value };
  if (e.kind === "var") {
    if (e.name === "user.id") return { kind: "userId" };
    return ctx.columns.get(e.name) ?? null;
  }
  return null;
};

const isColumn = (o: unknown): o is { column: string; type: FieldType } =>
  typeof o === "object" && o !== null && "column" in o;

/** Ring 1 predicate → WhereNode, or null when it cannot be expressed as SQL with identical semantics. */
export const toWhereNode = (expr: Expression, ctx: WhereContext): WhereNode | null => {
  switch (expr.kind) {
    case "eq": {
      const l = operand(expr.left, ctx);
      const r = operand(expr.right, ctx);
      if (l === null || r === null) return null;
      const col = isColumn(l) ? l : isColumn(r) ? r : null;
      const val = isColumn(l) ? r : l;
      if (col === null || isColumn(val)) return null; // record-vs-record or lit-vs-lit
      if (!compatible(col.type, val as WhereValue)) return null;
      return { kind: "eq", column: col.column, value: val as WhereValue };
    }
    case "and":
    case "or": {
      const args: WhereNode[] = [];
      for (const a of expr.args) {
        const n = toWhereNode(a, ctx);
        if (n === null) return null;
        args.push(n);
      }
      return { kind: expr.kind, args };
    }
    default:
      return null;
  }
};
```

`render-eloquent.ts`:

```ts
import type { WhereNode, WhereValue } from "./query-ast";

const phpLit = (v: WhereValue): string => {
  if (v.kind === "userId") return "$user->id";
  const x = v.value;
  if (x === null) return "null";
  if (typeof x === "boolean") return x ? "true" : "false";
  if (typeof x === "number") return JSON.stringify(x);
  return `'${x.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
};

const stmt = (node: WhereNode, q: string, user: string, or: boolean): string => {
  const method = or ? "orWhere" : "where";
  if (node.kind === "eq") {
    if (node.value.kind === "lit" && node.value.value === null) return `${q}->${or ? "orWhereNull" : "whereNull"}('${node.column}');`;
    return `${q}->${method}('${node.column}', '=', ${phpLit(node.value)});`;
  }
  const inner = node.args.map((a, i) => stmt(a, "$q", user, node.kind === "or" && i > 0)).join(" ");
  return `${q}->${method}(function ($q) use (${user}) { ${inner} });`;
};

/** PHP statements applying `node` to the Eloquent/Query Builder variable `q` for `user`. */
export const renderEloquent = (node: WhereNode, q: string, user: string): string => stmt(node, q, user, false);
```

`render-sql.ts` (test renderer; literals inlined, strings single-quote escaped):

```ts
import type { WhereNode, WhereValue } from "./query-ast";

const sqlLit = (v: WhereValue, userId: number): string => {
  if (v.kind === "userId") return String(userId);
  const x = v.value;
  if (x === null) return "NULL";
  if (typeof x === "boolean") return x ? "1" : "0";
  if (typeof x === "number") return String(x);
  return `'${x.replace(/'/g, "''")}'`;
};

export const renderSql = (node: WhereNode, userId: number): string => {
  if (node.kind === "eq") {
    if (node.value.kind === "lit" && node.value.value === null) return `(${node.column} IS NULL)`;
    return `(${node.column} = ${sqlLit(node.value, userId)})`;
  }
  return `(${node.args.map((a) => renderSql(a, userId)).join(node.kind === "and" ? " AND " : " OR ")})`;
};
```

- [ ] **Step 4: Run AST tests**

Run: `pnpm --filter @camis/adapter-filament test -- query-ast`
Expected: PASS.

- [ ] **Step 5: Write the PHP/SQLite conformance test**

`query-conformance.test.ts` — for a fixed rows table and a set of expressions, the TS evaluator's row filter must equal the SQLite result of `renderSql`. Uses PHP's built-in `pdo_sqlite`, skipped when `php` is absent (same guard as `permissions/tie-in.test.ts`).

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { evaluate } from "@camis/expr-ts";
import { renderSql, toWhereNode, whereContext } from "./query-ast";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

const hasPhp = (): boolean => {
  try { execFileSync("php", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
};

const activity = strapiApiBundle.document.contentTypes.find((c) => c.name === "Activity")!;
const ctx = whereContext(activity);
const v = (name: string): Expression => ({ kind: "var", name });
const lit = (value: string | number | boolean | null): Expression => ({ kind: "lit", value });

type Row = { id: number; name: string | null; visibility: string | null; creator_id: number | null };
const rows: Row[] = [
  { id: 1, name: "run", visibility: "public", creator_id: 1 },
  { id: 2, name: "swim", visibility: "private", creator_id: 1 },
  { id: 3, name: "bike", visibility: "private", creator_id: 2 },
  { id: 4, name: null, visibility: null, creator_id: null },
  { id: 5, name: "row", visibility: "public", creator_id: null },
];
const USER = 1;

const cases: { name: string; expr: Expression }[] = [
  { name: "public or mine", expr: { kind: "or", args: [
    { kind: "eq", left: v("record.visibility"), right: lit("public") },
    { kind: "eq", left: v("record.creatorId"), right: v("user.id") },
  ] } },
  { name: "mine", expr: { kind: "eq", left: v("record.creatorId"), right: v("user.id") } },
  { name: "name is null", expr: { kind: "eq", left: v("record.name"), right: lit(null) } },
  { name: "and", expr: { kind: "and", args: [
    { kind: "eq", left: v("record.visibility"), right: lit("private") },
    { kind: "eq", left: v("record.creatorId"), right: v("user.id") },
  ] } },
];

const expectedIds = (expr: Expression): number[] =>
  rows
    .filter((r) => {
      const res = evaluate(expr, {
        "record.name": r.name, "record.visibility": r.visibility, "record.creatorId": r.creator_id, "user.id": USER,
      });
      return res.ok && res.value === true;
    })
    .map((r) => r.id);

describe("query-ast SQLite conformance", () => {
  let dir = "";
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "query-conf-")); });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it.skipIf(!hasPhp())("SQL rendering selects exactly the rows the Ring 1 evaluator accepts", () => {
    for (const c of cases) {
      const node = toWhereNode(c.expr, ctx);
      expect(node, c.name).not.toBeNull();
      const where = renderSql(node!, USER);
      const inserts = rows
        .map((r) => `INSERT INTO t VALUES (${r.id}, ${r.name === null ? "NULL" : `'${r.name}'`}, ${r.visibility === null ? "NULL" : `'${r.visibility}'`}, ${r.creator_id === null ? "NULL" : r.creator_id});`)
        .join(" ");
      const php = `<?php $db = new PDO('sqlite::memory:'); $db->exec("CREATE TABLE t (id INTEGER, name TEXT, visibility TEXT, creator_id INTEGER); ${inserts}"); echo json_encode(array_map('intval', $db->query("SELECT id FROM t WHERE ${where} ORDER BY id")->fetchAll(PDO::FETCH_COLUMN)));`;
      const file = join(dir, "q.php");
      writeFileSync(file, php);
      const got = JSON.parse(execFileSync("php", [file], { encoding: "utf8" })) as number[];
      expect(got, c.name).toEqual(expectedIds(c.expr));
    }
  });
});
```

- [ ] **Step 6: Run conformance**

Run: `pnpm --filter @camis/adapter-filament test -- query-conformance`
Expected: PASS locally (PHP present) — in particular row 4 (all NULL) is excluded by "mine" and "public or mine" in both engines, and included only by "name is null".

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-filament/src/strapi-api
git commit -m "feat(adapter-filament): Ring 1 → WhereNode with Eloquent/SQL renderers + SQLite conformance"
```

---

### Task 7: Read conditions and assigns from the permission projection; `scopeForUser` emitter

**Files:**
- Modify: `packages/adapter-filament/src/permissions/project.ts`
- Create: `packages/adapter-filament/src/strapi-api/scope.ts`
- Test: `packages/adapter-filament/src/permissions/project.test.ts` (append), `packages/adapter-filament/src/strapi-api/scope.test.ts`

**Interfaces:**
- Produces:
  - `FilamentPermissions.readConditions: Map<string, Expression>` (content type → the `read` condition, first wins, same conflict rule as policies) and `FilamentPermissions.assigns: Map<string, string[]>` (content type → sorted relation names to fill from the user).
  - `emitScopeMethod(ct: ContentType, condition: Expression | undefined): { php: string; gap?: CapabilityGap }` — PHP for a `scopeForUser(Builder $q, User $user): Builder` method body. With a compilable condition the body applies `renderEloquent`; with an uncompilable one it returns `$q` unchanged plus a `downgrade` gap `listScopeFallback`; with no condition it returns `$q`.

- [ ] **Step 1: Failing projection test**

Append to `packages/adapter-filament/src/permissions/project.test.ts`:

```ts
import { strapiApiBundle } from "../strapi-api/__fixtures__/strapi-api";

describe("projectFilamentPermissions readConditions + assigns", () => {
  const p = projectFilamentPermissions(strapiApiBundle.document, strapiApiBundle.roles);
  it("exposes the read condition per content type", () => {
    expect(p.readConditions.get("Note")?.kind).toBe("eq");
    expect(p.readConditions.get("Activity")?.kind).toBe("or");
    expect(p.readConditions.has("Tag")).toBe(false);
  });
  it("exposes assigns per content type, sorted", () => {
    expect(p.assigns.get("Note")).toEqual(["owner"]);
    expect(p.assigns.get("Activity")).toEqual(["creator"]);
    expect(p.assigns.has("Tag")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @camis/adapter-filament test -- project`
Expected: FAIL — properties missing.

- [ ] **Step 3: Implement the projection additions**

In `project.ts`, extend the interface:

```ts
export interface FilamentPermissions {
  permissionKeys: string[];
  roleGrants: { role: string; keys: string[] }[];
  policies: PolicySpec[];
  readConditions: Map<string, Expression>;
  assigns: Map<string, string[]>;
  gaps: CapabilityGap[];
}
```

Inside the grant loop (after the `for (const action of grant.actions)` loop) add:

```ts
      if (grant.assign) {
        const cur = assigns.get(grant.contentType) ?? new Set<string>();
        Object.keys(grant.assign).forEach((k) => cur.add(k));
        assigns.set(grant.contentType, cur);
      }
```

declare `const assigns = new Map<string, Set<string>>();` next to `condByCa`, and in the return:

```ts
    readConditions: new Map(
      [...condByCa.entries()]
        .filter(([ca]) => ca.endsWith(".read"))
        .map(([ca, cond]) => [ca.slice(0, -".read".length), cond]),
    ),
    assigns: new Map([...assigns.entries()].map(([ct, s]) => [ct, [...s].sort()])),
```

- [ ] **Step 4: Failing scope test**

`scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { emitScopeMethod } from "./scope";

const ct = (n: string) => strapiApiBundle.document.contentTypes.find((c) => c.name === n)!;
const cond = (n: string) => strapiApiBundle.roles[0]!.grants.find((g) => g.contentType === n)!.condition;

describe("emitScopeMethod", () => {
  it("emits an Eloquent scope for a compilable condition", () => {
    const r = emitScopeMethod(ct("Activity"), cond("Activity"));
    expect(r.gap).toBeUndefined();
    expect(r.php).toContain("public function scopeForUser(Builder $q, User $user): Builder");
    expect(r.php).toContain("$q->orWhere('creator_id', '=', $user->id);");
  });
  it("falls back to an identity scope with a downgrade gap when not compilable", () => {
    const r = emitScopeMethod(ct("Activity"), { kind: "not", arg: cond("Note")! });
    expect(r.gap?.feature).toBe("listScopeFallback");
    expect(r.gap?.severity).toBe("downgrade");
    expect(r.php).toContain("return $q;");
  });
  it("emits an identity scope without a condition", () => {
    expect(emitScopeMethod(ct("Tag"), undefined).php).toContain("return $q;");
  });
});
```

- [ ] **Step 5: Implement `scope.ts`**

```ts
import type { Expression } from "@camis/expr";
import type { CapabilityGap, ContentType } from "@camis/ir-schema";
import { renderEloquent, toWhereNode, whereContext } from "./query-ast";

export interface ScopeEmit { php: string; gap?: CapabilityGap }

const method = (body: string): string =>
  `    /** Rows visible to $user (Strapi API style list scope). */\n    public function scopeForUser(Builder $q, User $user): Builder\n    {\n${body}\n    }`;

export const emitScopeMethod = (ct: ContentType, condition: Expression | undefined): ScopeEmit => {
  if (condition === undefined) return { php: method("        return $q;") };
  const node = toWhereNode(condition, whereContext(ct));
  if (node === null) {
    return {
      php: method("        return $q;"),
      gap: {
        feature: "listScopeFallback",
        location: { contentType: ct.name },
        severity: "downgrade",
        message: `read condition on "${ct.name}" is outside the SQL subset (eq/and/or over record.* vs literal or user.id); lists are filtered per record through the policy instead`,
      },
    };
  }
  return { php: method(`        ${renderEloquent(node, "$q", "$user")}\n\n        return $q;`) };
};
```

- [ ] **Step 6: Run tests**

Run: `pnpm --filter @camis/adapter-filament test -- "project|scope" && pnpm --filter @camis/adapter-filament typecheck`
Expected: PASS; existing `project.test.ts` cases still green.

- [ ] **Step 7: Commit**

```bash
git add packages/adapter-filament/src/permissions/project.ts packages/adapter-filament/src/permissions/project.test.ts packages/adapter-filament/src/strapi-api/scope.ts packages/adapter-filament/src/strapi-api/scope.test.ts
git commit -m "feat(adapter-filament): read conditions + assigns in projection; scopeForUser emitter"
```

---

### Task 8: Strapi-style controllers (generated base + protected subclass) and routes

**Files:**
- Create: `packages/adapter-filament/src/strapi-api/controller.ts`, `packages/adapter-filament/src/strapi-api/routes.ts`
- Test: `packages/adapter-filament/src/strapi-api/controller.test.ts`
- Golden: `__golden__/strapi-api/Generated.NoteApiController.php`, `Generated.ActivityApiController.php`, `NoteApiController.php`, `routes.api.php`

**Interfaces:**
- Consumes: `WireShape` (Task 4), `assigns` (Task 7), `routePath` (Task 4).
- Produces:

  ```ts
  export interface ControllerSpec { shape: WireShape; ct: ContentType; assigns: string[]; secured: boolean; scoped: boolean }
  export const emitGeneratedController = (spec: ControllerSpec): string;   // App\Http\Controllers\Api\Generated\<Model>ApiController
  export const emitProtectedController = (model: string): string;          // App\Http\Controllers\Api\<Model>ApiController extends Generated\… (seed)
  export const emitStrapiRoutes = (cts: ContentType[], secured: boolean): string;
  ```

  `scoped` is true when roles exist (the model has `scopeForUser`); `secured` mirrors the existing flag. `assigns` are relation names; the FK column is `${snakeColumn(name)}_id`.

- [ ] **Step 1: Failing golden tests**

```ts
import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { emitGeneratedController, emitProtectedController } from "./controller";
import { emitStrapiRoutes } from "./routes";
import { wireShape } from "./wire-shape";

const doc = normalize(strapiApiBundle.document);
const ct = (n: string) => doc.contentTypes.find((c) => c.name === n)!;

describe("strapi-api controllers", () => {
  it("Note generated controller golden (upsert by record_id, owner assign)", async () => {
    await expect(
      emitGeneratedController({ shape: wireShape(doc, ct("Note"), ["owner_id"]), ct: ct("Note"), assigns: ["owner"], secured: true, scoped: true }),
    ).toMatchFileSnapshot("./__golden__/strapi-api/Generated.NoteApiController.php");
  });
  it("Activity generated controller golden (creator assign, or-scope)", async () => {
    await expect(
      emitGeneratedController({ shape: wireShape(doc, ct("Activity"), ["creator_id"]), ct: ct("Activity"), assigns: ["creator"], secured: true, scoped: true }),
    ).toMatchFileSnapshot("./__golden__/strapi-api/Generated.ActivityApiController.php");
  });
  it("protected subclass golden", async () => {
    await expect(emitProtectedController("Note")).toMatchFileSnapshot("./__golden__/strapi-api/NoteApiController.php");
  });
  it("routes golden (kebab plural paths, auth + health, sanctum group)", async () => {
    await expect(emitStrapiRoutes(doc.contentTypes.filter((c) => c.builtin === undefined), true)).toMatchFileSnapshot(
      "./__golden__/strapi-api/routes.api.php",
    );
  });
  it("without upsertBy the key is id and PUT has no create branch", () => {
    const php = emitGeneratedController({ shape: wireShape(doc, ct("Tag"), []), ct: ct("Tag"), assigns: [], secured: false, scoped: false });
    expect(php).toContain("private const KEY = 'id';");
    expect(php).not.toContain("wasRecentlyCreated");
    expect(php).not.toContain("->forUser(");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @camis/adapter-filament test -- controller`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement `controller.ts`**

```ts
import type { ContentType } from "@camis/ir-schema";
import { PHP_MARKER } from "../hooks/names";
import { snakeColumn } from "../names";
import type { WireShape } from "./wire-shape";

export interface ControllerSpec {
  shape: WireShape;
  ct: ContentType;
  assigns: string[];
  secured: boolean;
  scoped: boolean;
}

export const emitGeneratedController = (spec: ControllerSpec): string => {
  const { shape, secured, scoped } = spec;
  const M = shape.model;
  const S = `${M}Serializer`;
  const auth = (line: string): string => (secured ? `        ${line}\n` : "");
  const query = scoped ? `${M}::query()->forUser($request->user())` : `${M}::query()`;
  const assign = spec.assigns
    .map((name) => `        $m->${snakeColumn(name)}_id = $request->user()->id;`)
    .join("\n");
  const assignBlock = assign ? `${assign}\n` : "";
  const upsert = shape.keyColumn !== "id";

  const createBranch = upsert
    ? `
        if (${M}::query()->where(self::KEY, $key)->exists()) {
            abort(404); // claimed by another scope: never reach across owners
        }
${auth(`$this->authorize('create', ${M}::class);`)}        $m = new ${M}($wire['columns']);
        $m->{self::KEY} = $key;
${assignBlock}        $m->save();
        ${S}::syncChildren($m, $wire['children']);

        return response()->json(['data' => ${S}::toWire($m->fresh())], 200);`
    : `
        abort(404);`;

  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api\\Generated;

use App\\Http\\Controllers\\Controller;
use App\\Http\\Serializers\\${S};
use App\\Models\\${M};${secured ? "\nuse Illuminate\\Foundation\\Auth\\Access\\AuthorizesRequests;" : ""}
use Illuminate\\Database\\Eloquent\\Builder;
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\Request;

class ${M}ApiController extends Controller
{
${secured ? "    use AuthorizesRequests;\n\n" : ""}    private const KEY = '${shape.keyColumn}';

    protected function scoped(Request $request): Builder
    {
        return ${query};
    }

    /** Fail closed: a row outside the caller's view is indistinguishable from a missing one. */
    protected function find(Request $request, string $key): ${M}
    {
        $m = $this->scoped($request)->where(self::KEY, $key)->first();
        if ($m === null${secured ? ` || ! $request->user()->can('view', $m)` : ""}) {
            abort(404);
        }

        return $m;
    }

    public function index(Request $request): JsonResponse
    {
${auth(`$this->authorize('viewAny', ${M}::class);`)}        $rows = $this->scoped($request)->get()${secured ? `->filter(fn (${M} $m) => $request->user()->can('view', $m))` : ""};

        return response()->json(['data' => $rows->map(fn (${M} $m) => ${S}::toWire($m))->values()->all()]);
    }

    public function show(Request $request, string $key): JsonResponse
    {
        $m = $this->find($request, $key);

        return response()->json(['data' => ${S}::toWire($m)]);
    }

    public function store(Request $request): JsonResponse
    {
${auth(`$this->authorize('create', ${M}::class);`)}        $wire = ${S}::fromWire((array) $request->input('data', []));
        $m = new ${M}($wire['columns']);
${assignBlock}        $m->save();
        ${S}::syncChildren($m, $wire['children']);

        return response()->json(['data' => ${S}::toWire($m->fresh())], 201);
    }

    public function update(Request $request, string $key): JsonResponse
    {
        $wire = ${S}::fromWire((array) $request->input('data', []));
        $m = $this->scoped($request)->where(self::KEY, $key)->first();
        if ($m !== null${secured ? ` && $request->user()->can('view', $m)` : ""}) {
${auth(`$this->authorize('update', $m);`)}            $m->fill($wire['columns'])->save();
            ${S}::syncChildren($m, $wire['children']);

            return response()->json(['data' => ${S}::toWire($m->fresh())]);
        }
${createBranch}
    }

    public function destroy(Request $request, string $key): JsonResponse
    {
        $m = $this->find($request, $key);
${auth(`$this->authorize('delete', $m);`)}        $m->delete();

        return response()->json(null, 204);
    }
}
`;
};

// Protected seam (mode: seed): hand-written overrides go here and survive regeneration.
export const emitProtectedController = (model: string): string => `<?php

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Api\\Generated\\${model}ApiController as Generated;

// Hand-written overrides for ${model}. camis seeds this file once and never overwrites it.
// Override store()/update()/index() here and call parent:: for the generated behavior.
class ${model}ApiController extends Generated
{
}
`;
```

- [ ] **Step 4: Implement `routes.ts`**

```ts
import type { ContentType } from "@camis/ir-schema";
import { filamentNames } from "../names";
import { routePath } from "./names";

export const emitStrapiRoutes = (cts: ContentType[], secured: boolean): string => {
  const sorted = [...cts].sort((a, b) => routePath(a).localeCompare(routePath(b)));
  const uses = [
    "App\\Http\\Controllers\\Api\\AuthController",
    ...sorted.map((ct) => `App\\Http\\Controllers\\Api\\${filamentNames(ct).model}ApiController`),
    "App\\Http\\Middleware\\StrapiErrors",
    "Illuminate\\Support\\Facades\\Route",
  ]
    .sort()
    .map((u) => `use ${u};`)
    .join("\n");
  const resources = sorted
    .map((ct) => {
      const p = routePath(ct);
      const c = `${filamentNames(ct).model}ApiController::class`;
      return `        Route::get('/${p}', [${c}, 'index']);
        Route::post('/${p}', [${c}, 'store']);
        Route::get('/${p}/{key}', [${c}, 'show']);
        Route::put('/${p}/{key}', [${c}, 'update']);
        Route::delete('/${p}/{key}', [${c}, 'destroy']);`;
    })
    .join("\n\n");
  const guard = secured ? "Route::middleware('auth:sanctum')" : "Route::middleware([])";
  return `<?php

// @camis:generated — do not edit. Custom routes belong in routes/api-custom.php.

declare(strict_types=1);

${uses}

Route::middleware([StrapiErrors::class])->group(function (): void {
    Route::get('/_health', fn () => response()->noContent());
    Route::post('/auth/local', [AuthController::class, 'login']);
    Route::post('/auth/local/register', [AuthController::class, 'register']);

    ${guard}->group(function (): void {
        Route::get('/users/me', [AuthController::class, 'me']);

${resources}
    });
});

require __DIR__.'/api-custom.php';
`;
};
```

- [ ] **Step 5: Run tests, inspect goldens, re-run for idempotence**

Run: `pnpm --filter @camis/adapter-filament test -- controller` (twice)
Expected: PASS both times. In `routes.api.php` confirm `/activities`, `/activity-sessions`, `/notes`, `/tags`, `/transactions` in that order.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-filament/src/strapi-api
git commit -m "feat(adapter-filament): strapi-api controllers (generated base + protected seed) and routes"
```

---

### Task 9: Auth controller, username migration, Strapi error middleware

**Files:**
- Create: `packages/adapter-filament/src/strapi-api/auth.ts`, `packages/adapter-filament/src/strapi-api/errors.ts`
- Test: `packages/adapter-filament/src/strapi-api/auth.test.ts`
- Golden: `__golden__/strapi-api/AuthController.php`, `add_username_to_users_table.php`, `StrapiErrors.php`

**Interfaces:**
- Produces: `emitAuthController(defaultRole: string | undefined): string`, `USERNAME_MIGRATION_PATH = "database/migrations/0001_01_02_000000_add_username_to_users_table.php"`, `emitUsernameMigration(): string`, `emitStrapiErrorsMiddleware(): string`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { emitAuthController, emitUsernameMigration, USERNAME_MIGRATION_PATH } from "./auth";
import { emitStrapiErrorsMiddleware } from "./errors";

describe("strapi-api auth", () => {
  it("auth controller golden (with defaultRole)", async () => {
    await expect(emitAuthController("authenticated")).toMatchFileSnapshot("./__golden__/strapi-api/AuthController.php");
  });
  it("omits role assignment without a defaultRole", () => {
    expect(emitAuthController(undefined)).not.toContain("assignRole");
  });
  it("username migration golden sorts before the generated tables", async () => {
    expect(USERNAME_MIGRATION_PATH < "database/migrations/0001_01_02_000001_x.php").toBe(true);
    await expect(emitUsernameMigration()).toMatchFileSnapshot("./__golden__/strapi-api/add_username_to_users_table.php");
  });
  it("errors middleware golden", async () => {
    await expect(emitStrapiErrorsMiddleware()).toMatchFileSnapshot("./__golden__/strapi-api/StrapiErrors.php");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @camis/adapter-filament test -- auth`
Expected: FAIL.

- [ ] **Step 3: Implement `auth.ts`**

```ts
import { PHP_MARKER } from "../hooks/names";

export const USERNAME_MIGRATION_PATH =
  "database/migrations/0001_01_02_000000_add_username_to_users_table.php";

export const emitUsernameMigration = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->string('username')->unique()->after('name');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->dropColumn('username');
        });
    }
};
`;

const strapiUser = "['id' => $user->id, 'username' => $user->username, 'email' => $user->email]";

export const emitAuthController = (defaultRole: string | undefined): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Models\\User;
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Hash;
use Illuminate\\Validation\\ValidationException;

/** Strapi users-permissions–shaped auth over Sanctum personal access tokens. */
class AuthController extends Controller
{
    private const TOKEN_NAME = 'api';

    public function register(Request $request): JsonResponse
    {
        $data = $request->validate([
            'username' => ['required', 'string', 'min:3', 'unique:users,username'],
            'email' => ['required', 'email', 'unique:users,email'],
            'password' => ['required', 'string', 'min:6'],
        ]);
        $user = new User([
            'name' => $data['username'],
            'email' => $data['email'],
            'password' => Hash::make($data['password']),
        ]);
        $user->username = $data['username'];
        $user->save();
${defaultRole !== undefined ? `        $user->assignRole('${defaultRole}');\n` : ""}
        return response()->json($this->session($user));
    }

    public function login(Request $request): JsonResponse
    {
        $data = $request->validate([
            'identifier' => ['required', 'string'],
            'password' => ['required', 'string'],
        ]);
        $user = User::query()
            ->where('email', $data['identifier'])
            ->orWhere('username', $data['identifier'])
            ->first();
        if ($user === null || ! Hash::check($data['password'], $user->password)) {
            throw ValidationException::withMessages(['identifier' => 'Invalid identifier or password']);
        }

        return response()->json($this->session($user));
    }

    public function me(Request $request): JsonResponse
    {
        $user = $request->user();

        return response()->json(${strapiUser});
    }

    private function session(User $user): array
    {
        return [
            'jwt' => $user->createToken(self::TOKEN_NAME)->plainTextToken,
            'user' => ${strapiUser},
        ];
    }
}
`;
```

- [ ] **Step 4: Implement `errors.ts`**

```ts
import { PHP_MARKER } from "../hooks/names";

/** Converts every exception on API routes into Strapi's { error: { status, name, message } } body. */
export const emitStrapiErrorsMiddleware = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Middleware;

use Closure;
use Illuminate\\Auth\\Access\\AuthorizationException;
use Illuminate\\Auth\\AuthenticationException;
use Illuminate\\Database\\Eloquent\\ModelNotFoundException;
use Illuminate\\Http\\Request;
use Illuminate\\Validation\\ValidationException;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\HttpKernel\\Exception\\HttpExceptionInterface;
use Throwable;

class StrapiErrors
{
    public function handle(Request $request, Closure $next): Response
    {
        try {
            return $next($request);
        } catch (ValidationException $e) {
            return $this->error(400, 'ValidationError', collect($e->errors())->flatten()->first() ?? 'Validation failed');
        } catch (AuthenticationException $e) {
            return $this->error(401, 'UnauthorizedError', 'Missing or invalid credentials');
        } catch (AuthorizationException $e) {
            return $this->error(403, 'ForbiddenError', 'Forbidden');
        } catch (ModelNotFoundException $e) {
            return $this->error(404, 'NotFoundError', 'Not Found');
        } catch (HttpExceptionInterface $e) {
            return $this->error($e->getStatusCode(), 'HttpError', $e->getMessage() !== '' ? $e->getMessage() : 'Error');
        } catch (Throwable $e) {
            report($e);

            return $this->error(500, 'InternalServerError', 'Internal Server Error');
        }
    }

    private function error(int $status, string $name, string $message): Response
    {
        return response()->json(['error' => ['status' => $status, 'name' => $name, 'message' => $message]], $status);
    }
}
`;
```

- [ ] **Step 5: Run tests twice (idempotence), inspect goldens**

Run: `pnpm --filter @camis/adapter-filament test -- auth`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-filament/src/strapi-api
git commit -m "feat(adapter-filament): strapi-api auth controller, username migration, StrapiErrors middleware"
```

---

### Task 10: Orchestrate the Strapi style in `generate.ts`; scaffold patches `HasApiTokens`

**Files:**
- Create: `packages/adapter-filament/src/strapi-api/emit.ts`
- Modify: `packages/adapter-filament/src/generate.ts`, `packages/adapter-filament/src/model.ts` (accept extra methods), `packages/cli/src/commands/scaffold.ts`
- Test: `packages/adapter-filament/src/strapi-api/generate-strapi.test.ts`, `packages/cli/src/commands/scaffold.test.ts` (existing `patchUserModel` expectation)
- Golden: `__golden__/strapi-api/file-listing.txt`, `__golden__/strapi-api/Note.model.php`

**Interfaces:**
- Consumes: everything from Tasks 4–9; `projectFilamentPermissions(...).readConditions/assigns` (Task 7).
- Produces: `emitStrapiApi(input: { doc: IrDocument; bundle: IrBundle; emitted: ContentType[]; fkNames: Map<string, string[]> }): { files: GeneratedFile[]; gaps: CapabilityGap[]; scopeMethods: Map<string, string> }` — the controller/serializer/route/auth/error files plus the per-model `scopeForUser` PHP that `generate.ts` splices into `emitModel` via a new optional `extraMethods: string[]` parameter (appended after relation methods, before the closing brace; `use Illuminate\Database\Eloquent\Builder;` and `use App\Models\User;` added to the model's imports when present).

- [ ] **Step 1: Failing tests**

`generate-strapi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { catalog } from "../__fixtures__/catalog";

describe("filamentAdapter apiStyle strapi", () => {
  const result = filamentAdapter.generate(strapiApiBundle, { projectName: "oyl", apiStyle: "strapi" });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("file listing golden", async () => {
    await expect(
      result.files.map((f) => `${f.mode ?? "overwrite"} ${f.path}`).sort().join("\n"),
    ).toMatchFileSnapshot("./__golden__/strapi-api/file-listing.txt");
  });
  it("Note model gains scopeForUser", async () => {
    await expect(content("app/Models/Note.php")).toMatchFileSnapshot("./__golden__/strapi-api/Note.model.php");
  });
  it("emits no laravel-style controllers and reports no gaps for the OYL-shaped fixture", () => {
    expect(result.files.some((f) => f.path === "app/Http/Controllers/Api/NoteApiController.php" && f.mode === "seed")).toBe(true);
    expect(result.files.some((f) => f.path === "app/Http/Controllers/Api/Generated/NoteApiController.php")).toBe(true);
    expect(result.gaps.gaps).toEqual([]);
  });
  it("is idempotent", () => {
    expect(filamentAdapter.generate(strapiApiBundle, { projectName: "oyl", apiStyle: "strapi" })).toEqual(result);
  });
  it("apiStyle absent leaves the laravel style byte-identical", () => {
    expect(filamentAdapter.generate(catalog, { projectName: "blog" })).toEqual(
      filamentAdapter.generate(catalog, { projectName: "blog", apiStyle: "laravel" }),
    );
  });
});
```

Update the `patchUserModel` expectation in `packages/cli/src/commands/scaffold.test.ts` to:

```ts
    expect(patchUserModel("class User extends Authenticatable\n{\n    use HasFactory, Notifiable;\n")).toContain(
      "use HasFactory, Notifiable, \\Spatie\\Permission\\Traits\\HasRoles, \\Laravel\\Sanctum\\HasApiTokens;",
    );
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @camis/adapter-filament test -- generate-strapi && pnpm --filter @camis/cli test -- scaffold`
Expected: FAIL.

- [ ] **Step 3: Implement `emit.ts`**

```ts
import type { GeneratedFile } from "@camis/adapter-kernel";
import type { CapabilityGap, ContentType, IrDocument } from "@camis/ir-schema";
import type { IrBundle } from "@camis/permissions";
import { filamentNames } from "../names";
import { projectFilamentPermissions } from "../permissions/project";
import { emitAuthController, emitUsernameMigration, USERNAME_MIGRATION_PATH } from "./auth";
import { emitGeneratedController, emitProtectedController } from "./controller";
import { emitStrapiErrorsMiddleware } from "./errors";
import { emitStrapiRoutes } from "./routes";
import { emitScopeMethod } from "./scope";
import { emitSerializer } from "./serializer";
import { wireShape } from "./wire-shape";

export interface StrapiApiInput {
  doc: IrDocument;
  bundle: IrBundle;
  emitted: ContentType[];
  fkNames: Map<string, string[]>;
}
export interface StrapiApiEmission {
  files: GeneratedFile[];
  gaps: CapabilityGap[];
  /** content type name → scopeForUser PHP method (spliced into the model). */
  scopeMethods: Map<string, string>;
}

export const emitStrapiApi = (input: StrapiApiInput): StrapiApiEmission => {
  const { doc, bundle, emitted, fkNames } = input;
  const secured = bundle.roles.length > 0;
  const perm = secured
    ? projectFilamentPermissions(doc, bundle.roles)
    : { readConditions: new Map<string, never>(), assigns: new Map<string, string[]>() };
  const files: GeneratedFile[] = [];
  const gaps: CapabilityGap[] = [];
  const scopeMethods = new Map<string, string>();

  for (const ct of emitted) {
    const names = filamentNames(ct);
    const shape = wireShape(doc, ct, fkNames.get(ct.name) ?? []);
    files.push({ path: `app/Http/Serializers/${names.model}Serializer.php`, content: emitSerializer(shape) });
    files.push({
      path: `app/Http/Controllers/Api/Generated/${names.model}ApiController.php`,
      content: emitGeneratedController({
        shape,
        ct,
        assigns: perm.assigns.get(ct.name) ?? [],
        secured,
        scoped: secured,
      }),
    });
    files.push({
      path: `app/Http/Controllers/Api/${names.model}ApiController.php`,
      content: emitProtectedController(names.model),
      mode: "seed",
    });
    if (secured) {
      const scope = emitScopeMethod(ct, perm.readConditions.get(ct.name));
      scopeMethods.set(ct.name, scope.php);
      if (scope.gap) gaps.push(scope.gap);
    }
  }

  files.push({ path: "routes/api.php", content: emitStrapiRoutes(emitted, secured) });
  files.push({ path: "app/Http/Controllers/Api/AuthController.php", content: emitAuthController(bundle.defaultRole) });
  files.push({ path: USERNAME_MIGRATION_PATH, content: emitUsernameMigration() });
  files.push({ path: "app/Http/Middleware/StrapiErrors.php", content: emitStrapiErrorsMiddleware() });
  return { files, gaps, scopeMethods };
};
```

- [ ] **Step 4: Wire `generate.ts` and `model.ts`**

`model.ts` — add a 6th parameter `extraMethods: string[] = []` to `emitModel`. When non-empty, add `use App\\Models\\User;` and `use Illuminate\\Database\\Eloquent\\Builder;` to the sorted import block (merge with `relImports` so the block stays sorted and deduplicated) and append `\n${extraMethods.join("\n\n")}\n` after `relMethods`. With an empty array the output must be byte-identical to today (existing goldens prove it).

`generate.ts` — restructure the per-content-type loop so the controller emission is style-dependent:

```ts
  generate: (ir, options): GenerationResult => {
    const apiStyle = options.apiStyle ?? "laravel";
    // … existing setup unchanged …
    const strapi =
      apiStyle === "strapi"
        ? emitStrapiApi({ doc, bundle: ir, emitted, fkNames: rel.fkNames })
        : undefined;
```

Compute `emitted` before the loop (it already is). In the loop, replace the `emitModel(...)` call's argument list with the extra `strapi?.scopeMethods.get(ct.name) !== undefined ? [strapi.scopeMethods.get(ct.name)!] : []`, and wrap the existing `app/Http/Controllers/Api/${names.model}ApiController.php` push in `if (apiStyle === "laravel") { … }`. After the loop, replace

```ts
    files.push({ path: "routes/api.php", content: emitApiRoutes(emitted, { secured }) });
    files.push(apiCustomSeed());
```

with

```ts
    if (strapi) {
      files.push(...strapi.files);
      gaps.push(...strapi.gaps);
    } else {
      files.push({ path: "routes/api.php", content: emitApiRoutes(emitted, { secured: ir.roles.length > 0 }) });
    }
    files.push(apiCustomSeed());
```

(`GenerateAdapter.generate` already receives `options`; the existing implementation ignores it — start using it.)

`packages/cli/src/commands/scaffold.ts`:

```ts
const PATCHED_TRAIT_USE =
  "use HasFactory, Notifiable, \\Spatie\\Permission\\Traits\\HasRoles, \\Laravel\\Sanctum\\HasApiTokens;";

/** Add Spatie's HasRoles and Sanctum's HasApiTokens to the stock Laravel User model. Idempotent. */
export const patchUserModel = (source: string): string =>
  source.includes("HasApiTokens") ? source : source.replace(STOCK_TRAIT_USE, PATCHED_TRAIT_USE);
```

- [ ] **Step 5: Run the whole adapter + CLI suites (twice for idempotence)**

Run: `pnpm --filter @camis/adapter-filament test && pnpm --filter @camis/cli test && pnpm -r typecheck`
Expected: PASS, including every pre-existing golden unchanged (`git status` shows no modified files under `__golden__/` other than the new `strapi-api/` directory) and the Task 3 `AuthController.php` assertion now green.

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-filament packages/cli
git commit -m "feat(adapter-filament,cli): apiStyle strapi orchestration; scaffold adds HasApiTokens"
```

---

### Task 11: Gated CI — HTTP round-trip against a real Laravel app

**Files:**
- Modify: `packages/adapter-filament/scripts/overlay.ts`
- Create: `packages/adapter-filament/scripts/strapi-api-smoke.sh`
- Modify: `.github/workflows/adapter-filament-boot.yml`

**Interfaces:**
- Consumes: `strapiApiBundle` fixture; `filamentAdapter.generate(bundle, { projectName, apiStyle: "strapi" })`.
- Produces: `pnpm --filter @camis/adapter-filament overlay <dir> --style strapi`; a CI job `strapi-api` (sqlite) that boots `php artisan serve` and runs the smoke script.

- [ ] **Step 1: Extend `overlay.ts`**

```ts
import { materialize } from "@camis/adapter-kernel";
import { filamentAdapter } from "../src/generate";
import { bootBundle } from "../src/__fixtures__/boot";
import { strapiApiBundle } from "../src/strapi-api/__fixtures__/strapi-api";

const dest = process.argv[2];
const style = process.argv[3] === "--style" ? process.argv[4] : undefined;
if (!dest) {
  console.error("usage: tsx scripts/overlay.ts <laravel-app-dir> [--style strapi]");
  process.exit(1);
}
const result =
  style === "strapi"
    ? filamentAdapter.generate(strapiApiBundle, { projectName: "oyl", apiStyle: "strapi" })
    : filamentAdapter.generate(bootBundle, { projectName: "blog" });
await materialize(result, dest);
console.log(`overlay materialized into ${dest}${style ? ` (apiStyle ${style})` : ""}`);
```

- [ ] **Step 2: Write the smoke script**

`packages/adapter-filament/scripts/strapi-api-smoke.sh` (executable; needs `curl` + `jq`, both present on `ubuntu-latest`):

```bash
#!/usr/bin/env bash
# HTTP round trip against a running strapi-style app: register → login → CRUD/upsert → cross-owner 404.
set -euo pipefail
BASE="${1:?usage: strapi-api-smoke.sh <base-url e.g. http://127.0.0.1:8765/api>}"

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }
req() { # method path token body → prints "<status>\n<body>"
  local m="$1" p="$2" t="$3" b="${4:-}"
  local args=(-s -o /tmp/body -w '%{http_code}' -X "$m" -H 'Accept: application/json' -H 'Content-Type: application/json')
  [[ -n "$t" ]] && args+=(-H "Authorization: Bearer $t")
  [[ -n "$b" ]] && args+=(--data "$b")
  curl "${args[@]}" "$BASE$p"; echo; cat /tmp/body; echo
}
status() { sed -n 1p; }
body()   { sed -n 2p; }

[[ "$(req GET /_health '' | status)" == "204" ]] || fail "health"

A=$(req POST /auth/local/register '' '{"username":"alice","email":"alice@example.test","password":"secret1"}')
[[ "$(echo "$A" | status)" == "200" ]] || fail "register alice: $A"
TA=$(echo "$A" | body | jq -r .jwt); [[ -n "$TA" && "$TA" != "null" ]] || fail "no jwt"

L=$(req POST /auth/local '' '{"identifier":"alice","password":"secret1"}')
[[ "$(echo "$L" | status)" == "200" ]] || fail "login by username: $L"
[[ "$(req GET /users/me "$TA" | body | jq -r .username)" == "alice" ]] || fail "users/me"

BAD=$(req POST /auth/local '' '{"identifier":"alice","password":"wrong"}')
[[ "$(echo "$BAD" | status)" == "400" && "$(echo "$BAD" | body | jq -r .error.message)" != "null" ]] || fail "bad login shape: $BAD"

C=$(req POST /notes "$TA" '{"data":{"recordId":"n1","text":"hello","occurredAt":"2026-09-08T10:00:00.000Z","tags":["a"]}}')
[[ "$(echo "$C" | status)" == "201" ]] || fail "create: $C"
[[ "$(echo "$C" | body | jq -r .data.recordId)" == "n1" ]] || fail "create envelope: $C"
[[ "$(echo "$C" | body | jq 'has("data") and (.data|has("owner_id")|not) and (.data|has("record_id")|not)')" == "true" ]] || fail "wire keys: $C"

U=$(req PUT /notes/n2 "$TA" '{"data":{"text":"upsert-created","occurredAt":"2026-09-08T11:00:00.000Z"}}')
[[ "$(echo "$U" | status)" == "200" && "$(echo "$U" | body | jq -r .data.recordId)" == "n2" ]] || fail "put-create: $U"
U2=$(req PUT /notes/n2 "$TA" '{"data":{"text":"upsert-updated","occurredAt":"2026-09-08T11:00:00.000Z"}}')
[[ "$(echo "$U2" | body | jq -r .data.text)" == "upsert-updated" ]] || fail "put-update: $U2"

[[ "$(req GET /notes "$TA" | body | jq '.data|length')" == "2" ]] || fail "list count"

# Repeatable component round trip
S=$(req POST /activity-sessions "$TA" '{"data":{"recordId":"s1","quantities":[{"amount":2.5,"unit":"km"},{"amount":30,"unit":"min"}]}}')
[[ "$(echo "$S" | body | jq -c '[.data.quantities[]|.amount]')" == "[2.5,30]" ]] || fail "child round trip: $S"

# Embedded component + null omission
T=$(req POST /transactions "$TA" '{"data":{"recordId":"t1","amount":{"minor":1999,"currency":"USD"}}}')
[[ "$(echo "$T" | body | jq -c '.data.amount')" == '{"minor":1999,"currency":"USD"}' ]] || fail "embedded: $T"
[[ "$(echo "$T" | body | jq '.data|has("fee")')" == "false" ]] || fail "null omitted: $T"

# Catalog scoping: bob sees alice's public activity but not her private one
req POST /activities "$TA" '{"data":{"recordId":"a1","name":"run","visibility":"public"}}' >/dev/null
req POST /activities "$TA" '{"data":{"recordId":"a2","name":"swim","visibility":"private"}}' >/dev/null
B=$(req POST /auth/local/register '' '{"username":"bob","email":"bob@example.test","password":"secret1"}')
TB=$(echo "$B" | body | jq -r .jwt)
[[ "$(req GET /activities "$TB" | body | jq -c '[.data[].recordId]')" == '["a1"]' ]] || fail "catalog scope"

# Cross-owner: bob cannot see, update, or delete alice's note; PUT on her key is 404, not create
[[ "$(req GET /notes/n1 "$TB" | status)" == "404" ]] || fail "cross-owner show"
[[ "$(req PUT /notes/n1 "$TB" '{"data":{"text":"steal"}}' | status)" == "404" ]] || fail "cross-owner put"
[[ "$(req DELETE /notes/n1 "$TB" | status)" == "404" ]] || fail "cross-owner delete"
[[ "$(req GET /notes "$TB" | body | jq '.data|length')" == "0" ]] || fail "bob list empty"

[[ "$(req DELETE /notes/n1 "$TA" | status)" == "204" ]] || fail "delete"
[[ "$(req GET /notes/nope "$TA" | body | jq -r .error.name)" == "HttpError" ]] || fail "404 shape"
[[ "$(req GET /notes '' | status)" == "401" ]] || fail "unauthenticated"

echo "SMOKE OK"
```

Run `chmod +x packages/adapter-filament/scripts/strapi-api-smoke.sh`.

- [ ] **Step 3: Add the CI job**

Append to `.github/workflows/adapter-filament-boot.yml` a second job (sqlite only, reuses the scaffold steps; `HasApiTokens` patched alongside `HasRoles`):

```yaml
  strapi-api:
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
      - name: Scaffold Laravel 12 + Filament v5 + API + Spatie
        run: |
          composer create-project laravel/laravel:^12 app --no-interaction
          cd app
          composer require filament/filament:"^5.0" --no-interaction
          php artisan filament:install --panels --no-interaction
          php artisan install:api --no-interaction
          composer require spatie/laravel-permission --no-interaction
          php artisan vendor:publish --provider="Spatie\Permission\PermissionServiceProvider" --no-interaction
          php -r '$f="app/Models/User.php";$c=file_get_contents($f);$c=str_replace("use HasFactory, Notifiable;","use HasFactory, Notifiable, \\Spatie\\Permission\\Traits\\HasRoles, \\Laravel\\Sanctum\\HasApiTokens;",$c);file_put_contents($f,$c);'
      - name: Overlay (apiStyle strapi)
        run: pnpm --filter @camis/adapter-filament overlay "$GITHUB_WORKSPACE/app" --style strapi
      - name: Migrate + seed + serve
        run: |
          cd app
          echo "DB_CONNECTION=sqlite" >> .env
          touch database/database.sqlite
          php artisan migrate --force
          php artisan db:seed --class="Database\\Seeders\\RolePermissionSeeder" --force
          (php artisan serve --host=127.0.0.1 --port=8765 > serve.log 2>&1 &)
          for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8765/api/_health && break; sleep 1; done
      - name: HTTP round trip
        run: bash packages/adapter-filament/scripts/strapi-api-smoke.sh http://127.0.0.1:8765/api
      - name: Server log on failure
        if: failure()
        run: cat app/serve.log app/storage/logs/laravel.log || true
```

- [ ] **Step 4: Run it locally (composer + php present)**

From the camis root, in a scratch directory outside the repo:

```bash
SCRATCH=$(mktemp -d) && cd "$SCRATCH"
composer create-project laravel/laravel:^12 app --no-interaction && cd app
composer require filament/filament:"^5.0" --no-interaction && php artisan filament:install --panels --no-interaction
php artisan install:api --no-interaction
composer require spatie/laravel-permission --no-interaction
php artisan vendor:publish --provider="Spatie\Permission\PermissionServiceProvider" --no-interaction
php -r '$f="app/Models/User.php";$c=file_get_contents($f);$c=str_replace("use HasFactory, Notifiable;","use HasFactory, Notifiable, \\Spatie\\Permission\\Traits\\HasRoles, \\Laravel\\Sanctum\\HasApiTokens;",$c);file_put_contents($f,$c);'
cd /Users/hynding/Workspace/Repositories/com/github/hynding/camis
pnpm --filter @camis/adapter-filament overlay "$SCRATCH/app" --style strapi
cd "$SCRATCH/app" && echo "DB_CONNECTION=sqlite" >> .env && touch database/database.sqlite
php artisan migrate --force && php artisan db:seed --class="Database\\Seeders\\RolePermissionSeeder" --force
php artisan serve --host=127.0.0.1 --port=8765 &
sleep 3 && bash /Users/hynding/Workspace/Repositories/com/github/hynding/camis/packages/adapter-filament/scripts/strapi-api-smoke.sh http://127.0.0.1:8765/api
```

Expected: `SMOKE OK`. Fix emitters until it passes; every fix starts by extending a golden/unit test in Tasks 5–10 to capture the defect.

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-filament/scripts .github/workflows/adapter-filament-boot.yml
git commit -m "test(adapter-filament): gated strapi-api HTTP round-trip job"
```

---

### Task 12: Documentation

**Files:**
- Modify: `packages/cli/README.md`, `docs/PLAN.md`

- [ ] **Step 1: CLI README**

Under `## camis.config.json`, after the `roles` bullet, add:

```markdown
- `protected` (optional) is a directory mirrored into every target's `out` after generation —
  the home for hand-written seams (`routes/api-custom.php`, protected controller subclasses,
  hook implementations) so the generated app itself can stay git-ignored.
- `apiStyle` (filament only): `laravel` (default) or `strapi`. The Strapi style makes the
  generated JSON API a drop-in for a Strapi 5 client: `{ data }` envelope and
  `{ error: { status, name, message } }` errors, camelCase keys with components re-nested,
  nulls omitted, kebab-plural paths (`/activity-sessions`), `PUT /<path>/{key}` upsert keyed
  by `options.upsertBy`, lists scoped by the read grant's condition (compiled to SQL for
  `eq`/`and`/`or`, per-record policy filtering otherwise), create-time FK fill from the grant's
  `assign: { owner: "user.id" }`, Sanctum-backed `/auth/local`, `/auth/local/register`,
  `/users/me`, and `/_health`. Each controller is a generated base under
  `app/Http/Controllers/Api/Generated/` plus a seed-mode subclass you may override.
- The roles file is either a bare `Role[]` or `{ "defaultRole": "<role>", "roles": [...] }`;
  `defaultRole` is assigned on `/auth/local/register`.
- `camis import strapi <dir> --upsert-by recordId` sets `options.upsertBy` on every imported
  type that has a unique field of that name, so the IR stays fully regenerable.
```

Update the `Commands` list line for `import` to show `[--upsert-by <field>]`.

- [ ] **Step 2: PLAN.md**

In `docs/PLAN.md` Phase 16, change the Ring 1 bullet to read `eq/and/or` (not `eq/ne/and/or/not`) with the reason: SQL three-valued logic makes `ne`/`not` diverge from Ring 1 on NULL columns.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/README.md docs/PLAN.md
git commit -m "docs: Phase 16 strapi api style in CLI README + PLAN"
```

---

## Self-review

**Spec coverage (Part 1):** 1a envelope/casing/shape → Tasks 4, 5, 8; kebab paths → 4, 8. 1b errors → 9. 1c route key + PUT semantics + `--upsert-by` → 2, 8. 1d scoped lists + conformance → 6, 7, 8 (narrowed to `eq/and/or`, documented in Task 12). 1e `assign` → 1, 7, 8. 1f auth + username + `/_health` + `jwt` opaque → 9, 8. 1g generated base + protected subclass → 8, 10. 1h `protected` overlay → 2, 3. Config additions → 2, 3. Exit criteria (round trip, goldens unchanged) → 10, 11.

**Placeholder scan:** none; every code step is concrete. The one intentionally-red assertion (Task 3, `AuthController.php`) is called out and turns green in Task 10.

**Type consistency:** `WireShape/WireScalar/WireChild` (Task 4) used verbatim in 5, 8, 10; `WhereNode/WhereValue/whereContext/toWhereNode/renderEloquent/renderSql` (6) used in 7; `emitScopeMethod → { php, gap? }` (7) used in 10; `FilamentPermissions.readConditions/assigns` (7) used in 10; `IrBundle.defaultRole` (1) used in 3, 9, 10; `GenerateOptions.apiStyle` (2) used in 3, 10, 11; `Io.copyDir` (3) added to every fake `Io` in CLI tests.
