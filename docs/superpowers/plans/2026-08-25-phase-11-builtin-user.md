# Phase 11 — Built-in User Content Type Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relations to a target's native user model (Strapi `plugin::users-permissions.user`, Laravel's stock `App\Models\User`) become representable in the IR via a `builtin: "user"` content-type marker, so importing a real Strapi project (e.g. OYL) with owner/creator relations succeeds and generates correctly on every target.

**Architecture:** The IR gains an optional `builtin: "user"` marker on `contentType`. The Strapi importer maps `plugin::users-permissions.user` relation targets to a synthesized builtin `User` content type (other `plugin::` targets become downgrade gaps instead of dangling names). The Strapi generator round-trips the marker (emits `plugin::users-permissions.user` targets, skips schema emission for the builtin type). The Filament adapter skips model/migration/resource emission for builtin types — relations resolve against Laravel's stock `users` table. Express needs no change: it has no native user model, so materializing the builtin as a regular `users` table is the correct mapping.

**Tech Stack:** TypeScript strict, Zod, Vitest. Repo conventions: TDD red→green per task, `feat(pkg):`/`test(pkg):` commits, golden files byte-exact.

**Spec:** The evaluation in this session (measured against OYL): all 12 OYL content types fail import with `unknown_relation_target "UsersPermissions"` from `packages/adapter-strapi/src/import/attributes.ts:38`.

## Global Constraints

- Neutral IR vocabulary: the marker is `builtin: "user"` — no target terms (`users-permissions`, `Eloquent`) in IR or shared packages.
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are on — optional keys must be omitted, not set `undefined`.
- Golden tests are byte-compared; existing goldens must not change (no builtin type in existing fixtures).
- Determinism: stable ordering; synthesized `User` appended after imported content types.
- No production code without a failing test first.

---

### Task 1: IR schema — `builtin: "user"` marker

**Files:**
- Modify: `packages/ir-schema/src/document.ts` (contentType object)
- Test: `packages/ir-schema/src/document.test.ts`

**Interfaces:**
- Produces: `ContentType.builtin?: "user"` (inferred type), accepted by `parseDocument`/`validate`.

- [ ] **Step 1: Failing test** — a content type with `builtin: "user"` parses and retains the marker; `builtin: "team"` is rejected.

```ts
it("accepts builtin: 'user' on a content type and preserves it", () => {
  const r = parseDocument({
    version: 1,
    contentTypes: [
      { name: "User", kind: "collection", builtin: "user", fields: [{ type: "string", name: "username" }] },
    ],
    components: [],
  });
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.contentTypes[0]?.builtin).toBe("user");
});

it("rejects unknown builtin kinds", () => {
  const r = parseDocument({
    version: 1,
    contentTypes: [{ name: "Team", kind: "collection", builtin: "team", fields: [] }],
    components: [],
  });
  expect(r.ok).toBe(false);
});
```

- [ ] **Step 2: Run** `pnpm --filter @camis/ir-schema test` — expect FAIL (unknown key stripped / not rejected).
- [ ] **Step 3: Implement** — in `contentType`, after `kind`, add:

```ts
    builtin: z.literal("user").optional(),
```

- [ ] **Step 4: Run** — expect PASS (all ir-schema tests green).
- [ ] **Step 5: Commit** `feat(ir-schema): builtin "user" marker on content types`

### Task 2: Strapi importer — plugin user mapping + synthesis + plugin-target gaps

**Files:**
- Modify: `packages/adapter-strapi/src/import/attributes.ts`
- Modify: `packages/adapter-strapi/src/import/schema.ts` (thread `builtinUser` flag out of `fieldsFromAttributes`)
- Modify: `packages/adapter-strapi/src/import/import-document.ts`
- Test: `packages/adapter-strapi/src/import/attributes.test.ts`, `packages/adapter-strapi/src/import/import-document.test.ts`

**Interfaces:**
- Consumes: `ContentType.builtin` from Task 1.
- Produces: `IrFieldResult` gains `builtinUser?: true`; `irContentType` result gains `usesBuiltinUser: boolean`; `BUILTIN_USER` content type exported from `import-document.ts` for tests.

- [ ] **Step 1: Failing tests**

`attributes.test.ts`:
```ts
it("maps a plugin::users-permissions.user relation to the builtin User target", () => {
  const r = irField("owner", { type: "relation", relation: "manyToOne", target: "plugin::users-permissions.user" }, { contentType: "Note" });
  expect(r.field).toEqual({ type: "relation", name: "owner", relationKind: "manyToOne", target: "User" });
  expect(r.builtinUser).toBe(true);
});

it("reports other plugin:: relation targets as downgrade gaps", () => {
  const r = irField("file", { type: "relation", relation: "oneToOne", target: "plugin::upload.file" }, { contentType: "Note" });
  expect(r.field).toBeUndefined();
  expect(r.gap?.severity).toBe("downgrade");
});
```

`import-document.test.ts`:
```ts
it("synthesizes a builtin User content type when plugin user relations are imported", () => {
  const files = [noteSchemaFileWithOwnerRelationToPluginUser];
  const { document } = importDocument(files);
  expect(document.ok).toBe(true);
  if (document.ok) {
    const user = document.value.contentTypes.find((ct) => ct.name === "User");
    expect(user?.builtin).toBe("user");
  }
});

it("does not synthesize User when the project defines api::user.user itself", () => { /* files include a user schema; expect exactly one User, no builtin marker */ });
```

- [ ] **Step 2: Run** `pnpm --filter @camis/adapter-strapi test` — expect FAIL.
- [ ] **Step 3: Implement**

`attributes.ts` relation branch:
```ts
if (strapiType === "relation") {
  if (attr.mappedBy !== undefined) return { skip: true };
  const rawTarget = String(attr.target);
  if (rawTarget === "plugin::users-permissions.user") {
    const field: Record<string, unknown> = { type: "relation", name, relationKind: attr.relation, target: "User" };
    if (attr.inversedBy !== undefined) field.inverse = attr.inversedBy;
    return { field: field as Field, builtinUser: true };
  }
  if (rawTarget.startsWith("plugin::")) {
    return { gap: { feature: "pluginRelation", location: { ...location, field: name }, severity: "downgrade",
      message: `relation "${name}" targets plugin type "${rawTarget}", which has no IR representation; skipped.` } };
  }
  // ...existing api:: path unchanged
}
```

`import-document.ts` after the file loop:
```ts
const usesBuiltinUser = /* OR of per-content-type flags */;
if (usesBuiltinUser && !contentTypes.some((ct) => ct.name === "User")) {
  contentTypes.push(BUILTIN_USER);
}
```
with
```ts
export const BUILTIN_USER: ContentType = {
  name: "User",
  kind: "collection",
  builtin: "user",
  fields: [
    { type: "string", name: "username", required: true, unique: true },
    { type: "email", name: "email", required: true },
  ],
};
```

- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(adapter-strapi): import plugin user relations as builtin User`

### Task 3: Strapi generator — round-trip the builtin user

**Files:**
- Modify: `packages/adapter-strapi/src/attributes.ts` (`toAttribute`/`toAttributes` take `builtinUsers: ReadonlySet<string>`)
- Modify: `packages/adapter-strapi/src/schema.ts`, `packages/adapter-strapi/src/component-schema.ts` (thread the set)
- Modify: `packages/adapter-strapi/src/generate.ts` (skip `typeFiles` for builtin cts; build the set)
- Test: `packages/adapter-strapi/src/generate.test.ts`, `packages/adapter-strapi/src/round-trip.test.ts`

**Interfaces:**
- Consumes: `ContentType.builtin`, `BUILTIN_USER`.
- Produces: `toAttributes(fields, builtinUsers)` — all existing call sites updated; relation to a builtin-user type emits `target: "plugin::users-permissions.user"` and NO `inversedBy` mapping is synthesized into the builtin type (it has no schema file).

- [ ] **Step 1: Failing tests** — generate a doc containing builtin User + `Note.owner → User`:
  - no `src/api/user/**` files are emitted;
  - Note's schema.json attribute `owner` has `target: "plugin::users-permissions.user"`;
  - round-trip: `importDocument(generatedFiles)` reproduces the original document (builtin User re-synthesized).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — in `generate.ts`: `const builtinUsers = new Set(doc.contentTypes.filter((ct) => ct.builtin === "user").map((ct) => ct.name));` filter `typeFiles`/`synthesizedInverses` emission to non-builtin cts; in `attributes.ts` relation branch: `attr.target = builtinUsers.has(field.target) ? "plugin::users-permissions.user" : `api::${targetSingular}.${targetSingular}`;`
- [ ] **Step 4: Run** — expect PASS, goldens unchanged.
- [ ] **Step 5: Commit** `feat(adapter-strapi): round-trip builtin User to plugin::users-permissions.user`

### Task 4: Filament — builtin user resolves to the stock Laravel User

**Files:**
- Modify: `packages/adapter-filament/src/generate.ts`
- Test: `packages/adapter-filament/src/generate.test.ts`

**Interfaces:**
- Consumes: `ContentType.builtin`.
- Produces: for builtin cts, NO `app/Models/*.php`, migration, or resource files; relations from other types still emit `BelongsTo(User::class, 'owner_id')` and `->constrained('users')` (via unchanged `resolveRelations`, since `filamentNames({name:"User"})` yields table `users`). Migration ordinals number only emitted (non-builtin) types; pivot ordinals continue from the emitted count.

- [ ] **Step 1: Failing test** — doc with builtin User + `Note.owner (manyToOne → User)`:

```ts
it("maps builtin User relations onto the stock Laravel User without emitting user files", () => {
  const result = filamentAdapter.generate({ document: docWithBuiltinUser, roles: [] }, { projectName: "t" });
  const paths = result.files.map((f) => f.path);
  expect(paths).not.toContain("app/Models/User.php");
  expect(paths.some((p) => p.includes("create_users_table"))).toBe(false);
  const note = result.files.find((f) => f.path === "app/Models/Note.php")!;
  expect(note.content).toContain("belongsTo(User::class, 'owner_id')");
  const migration = result.files.find((f) => f.path.includes("create_notes_table"))!;
  expect(migration.content).toContain("->constrained('users')");
});
```

- [ ] **Step 2: Run** `pnpm --filter @camis/adapter-filament test` — expect FAIL.
- [ ] **Step 3: Implement** — in `generate.ts`: `const emitted = doc.contentTypes.filter((ct) => ct.builtin === undefined);` iterate `emitted` for the model/migration/resource loop (ordinal `i + 1`), and pivot ordinals use `emitted.length + 1 + j`. Gap scanning also iterates `emitted` only.
- [ ] **Step 4: Run** — expect PASS; all goldens unchanged (no fixture uses builtin).
- [ ] **Step 5: Commit** `feat(adapter-filament): builtin User maps to the stock Laravel User model`

### Task 5: End-to-end CLI proof against a plugin-user project

**Files:**
- Test: `packages/cli/src/run.test.ts` (new e2e case, following the existing temp-dir pattern)

- [ ] **Step 1: Failing test** — write a minimal Strapi project to a temp dir (one `note` schema with an `owner` relation to `plugin::users-permissions.user`), run `camis import strapi <dir> --out camis.json`, expect exit 0 and the written IR to contain builtin User; then `camis generate` with a filament target on that IR, expect exit 0 and no user model in the listing.
- [ ] **Step 2: Run** `pnpm --filter @camis/cli test` — expect FAIL (import previously exited 1).
- [ ] **Step 3: Implementation** — none expected; this is an integration lock. If it fails, fix in the owning package, not the CLI.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `test(cli): end-to-end import of a project with plugin user relations`

### Task 6: Validate against the real OYL corpus + docs

- [ ] **Step 1:** Run the import against `../oyl/apps/strapi-oyl` (output to scratchpad, NOT committed). Expected: exit 0, 13 content types (12 + synthesized User), gaps limited to component downgrades at generate time.
- [ ] **Step 2:** Update `packages/cli/README.md` (import section: plugin user handling) and `docs/PLAN.md` Phase 11 exit criteria checked.
- [ ] **Step 3:** `pnpm -r test` green; commit `docs: Phase 11 builtin user — README + PLAN`; merge branch `phase-11-builtin-user` into master.
