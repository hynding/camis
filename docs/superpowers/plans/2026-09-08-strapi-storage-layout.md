# camis Phase 17 — Strapi storage layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A filament target with `storageLayout: "strapi"` emits a Laravel app that runs on the database a Strapi 5 app created and still uses — same rows, same users, same tokens — proven by a CI job that writes through Strapi, reads through PHP, and back.

**Architecture:** All new code lives under `packages/adapter-filament/src/strapi-api/storage/` and is selected by `GenerateOptions.storageLayout`; the Phase 16 serializers, controllers, routes, error middleware, and scope emitter are reused, with small layout switches where they touch the model layer or auth. A dedicated walker maps each content type's components onto Strapi's `_cmps` links and component tables; an emitted PHP runtime (`StrapiRows`, `StrapiComponents`, `StrapiDateTime`, `StrapiJwtGuard`) does the Strapi bookkeeping. The IR gains `Component.names` so table and `component_type` names round-trip from a real Strapi project. The Strapi target gains users-permissions grants so a camis-generated Strapi app can serve as the schema owner in the cross-check.

**Tech Stack:** TypeScript (ESM, strict, Vitest goldens), zod; emitted PHP 8.3+/Laravel 12 with `firebase/php-jwt` and `visus/cuid2`; Strapi 5 (users-permissions plugin) for the cross-check; SQLite in tests, MySQL/Postgres in production via the same cast.

**Spec:** `../../../oyl/docs/superpowers/specs/2026-09-08-strapi-storage-layout-design.md` (sections 17a–17k and Testing). Phase 17 summary in `docs/PLAN.md`.

## Global Constraints

- TDD: failing test first, minimal code, refactor; codegen golden-tested with `toMatchFileSnapshot`, regenerated goldens are read and `php -l`'d, second run = no diff.
- `storageLayout` absent (or `"laravel"`) ⇒ every existing golden and test byte-identical. Strapi-target goldens byte-identical when `Component.names` is absent.
- `storageLayout: "strapi"` requires `apiStyle: "strapi"`; anything else is a config error.
- Emitted PHP: PSR-12, `declare(strict_types=1)`, `PHP_MARKER` header, deterministic ordering, ≤120-char lines.
- Strapi facts (verified 2026-09-08): link table `<collection>_<relation>_lnk(<singular>_id, user_id[, <singular>_ord])` — the `_ord` column exists only when the IR relation has an `inverse`; component link table `<collection>_cmps(entity_id, cmp_id, component_type, field, order)` with `order` NULL for non-repeatables and 1..n for repeatables; nested component links on `<component table>_cmps`; component columns are `snake(field)`; `document_id` is a 24-char cuid2; `published_at` is set on every row; SQLite stores datetimes as millisecond integers; **no unique indexes** on `record_id`, `up_users.email`, `up_users.username`; `up_users_role_lnk(user_id, role_id, user_ord)`; JWT = HS256 over `{ id }` with `JWT_SECRET`, 30 days.
- No `any` across package boundaries; `exactOptionalPropertyTypes`; adapters never import siblings (the cross-check script lives in `cli`, which depends on all adapters).
- Commit messages `feat(<pkg>): …`/`fix(…)`/`test(…)`/`docs: …` with the trailer
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Run `pnpm -r typecheck && pnpm -r test` before every commit (baseline: 652 tests, master 48a6624; branch `phase-17/strapi-storage-layout`).

---

## File structure

**Modified**
- `packages/adapter-filament/src/strapi-api/wire-shape.ts`, `serializer.ts` (+ goldens) — Task 1 (nested repeatable key fix).
- `packages/ir-schema/src/document.ts`, `packages/adapter-strapi/src/import/{import-document,schema}.ts`, `packages/adapter-strapi/src/{generate,component-schema}.ts` — Task 2.
- `packages/adapter-strapi/src/skeleton/templates.ts`, `packages/adapter-strapi/src/permissions/{emit,project}.ts` — Task 3.
- `packages/adapter-kernel/src/types.ts`, `packages/cli/src/{config,run}.ts`, `packages/cli/src/commands/{generate,scaffold}.ts` — Task 4.
- `packages/adapter-filament/src/strapi-api/query-ast.ts`, `render-eloquent.ts`, `render-sql.ts`, `scope.ts` — Task 8.
- `packages/adapter-filament/src/strapi-api/controller.ts`, `routes.ts`, `auth.ts`, `emit.ts`, `packages/adapter-filament/src/permissions/policy.ts`, `packages/adapter-filament/src/generate.ts` — Tasks 9–11.
- `.github/workflows/`, `packages/cli/README.md`, `docs/PLAN.md` — Tasks 12–13.

**Created** (under `packages/adapter-filament/src/strapi-api/storage/`)
- `names.ts` — Strapi physical names from the IR.
- `component-map.ts` — per-content-type component mapping tree.
- `runtime.ts` — emitters for `StrapiDateTime`, `StrapiRows`, `StrapiComponents`, `StrapiComponentAttributes`, `StrapiJwtGuard`.
- `model.ts` — storage-layout model emitter (content types + `User`).
- `auth.ts` — JWT `AuthController`.
- `schema-check.ts` — `camis:strapi-schema-check` command emitter.
- `emit.ts` — orchestration for the layout.
- `__fixtures__/storage.ts` — fixture with nested + repeatable components, owner/creator relations, a relation with an inverse.
- `__golden__/storage/*`.
- `packages/cli/scripts/strapi-storage-crosscheck.ts` + `.github/workflows/strapi-storage-crosscheck.yml` — Task 12.

---

### Task 1: Fix the Phase 16 nested-repeatable wire key

A repeatable component nested inside a non-repeatable one (path `["facts","additional"]`) currently gets the flat key `"facts.additional"` on the wire, so it never nests under `facts` and `fromWire` never finds it. The storage layout's fixture exercises exactly that shape, so it is fixed first.

**Files:**
- Modify: `packages/adapter-filament/src/strapi-api/wire-shape.ts` (`WireChild.key: string[]`), `serializer.ts`
- Test: `packages/adapter-filament/src/strapi-api/serializer.test.ts`, `wire-shape.test.ts`

**Interfaces:**
- Produces: `WireChild.key: string[]` (path segments, camelCase). `toWire` nests the child list under its parent branch; `fromWire` reads it with `self::dig($data, [...])` and only sets the child key when the path exists (`self::has($data, [...])`).

- [ ] **Step 1: Failing tests**

Append to `wire-shape.test.ts` and `serializer.test.ts` a fixture with a nested repeatable:

```ts
const nestedDoc: IrDocument = normalize({
  version: 1,
  contentTypes: [
    { name: "Consumable", kind: "collection", fields: [
      { type: "string", name: "recordId", required: true, unique: true },
      { type: "component", name: "facts", component: "Facts", repeatable: false },
    ] },
  ],
  components: [
    { name: "Facts", fields: [
      { type: "decimal", name: "calories" },
      { type: "component", name: "additional", component: "Nutrient", repeatable: true },
    ] },
    { name: "Nutrient", fields: [{ type: "string", name: "slug" }, { type: "decimal", name: "amount" }] },
  ],
});
// wire-shape.test.ts
it("a repeatable nested in a non-repeatable keys by path", () => {
  const s = wireShape(nestedDoc, nestedDoc.contentTypes[0]!, []);
  expect(s.children[0]).toMatchObject({ key: ["facts", "additional"], relation: "factsAdditional" });
});
// serializer.test.ts
it("nests a nested repeatable under its parent on the wire and reads it back by path", () => {
  const php = emitSerializer(wireShape(nestedDoc, nestedDoc.contentTypes[0]!, []));
  expect(php).toContain("'facts' => self::nested([");
  expect(php).toContain("'additional' => $m->factsAdditional->map(");
  expect(php).not.toContain("'facts.additional'");
  expect(php).toContain("if (self::has($data, ['facts', 'additional'])) {");
  expect(php).toContain("self::dig($data, ['facts', 'additional'])");
});
```

- [ ] **Step 2: Run red** — `pnpm --filter @camis/adapter-filament test -- "wire-shape|serializer"`; expect the new cases to fail (`key` is a string; `'facts.additional'` present).

- [ ] **Step 3: Implement**

`wire-shape.ts`: `key: t.path.map(camelKey)` and `WireChild.key: string[]`.

`serializer.ts`: in `toWireBody`, `insert(root, c.key, …)` (already takes a path — pass the array). In `fromWireChildStatements` replace `array_key_exists('${c.key}', $data)` with `self::has($data, [${c.key.map(k => `'${k}'`).join(", ")}])` and `$data['${c.key}']` with `self::dig($data, [...])` (both occurrences). Add the helper next to `dig`:

```php
    private static function has(array $a, array $path): bool
    {
        $cur = $a;
        foreach ($path as $seg) {
            if (! is_array($cur) || ! array_key_exists($seg, $cur)) {
                return false;
            }
            $cur = $cur[$seg];
        }

        return true;
    }
```

Update `controller.test.ts`/goldens only if they reference `c.key` (they do not).

- [ ] **Step 4: Run green; regenerate goldens** — delete `__golden__/strapi-api/ActivitySessionSerializer.php`, run, READ it (top-level `quantities` must be unchanged: `'quantities' => $m->quantities->map(`), `php -l`, run again. `pnpm -r test` green.

- [ ] **Step 5: Commit** — `fix(adapter-filament): nested repeatable components nest under their parent on the wire`.

---

### Task 2: `Component.names` in the IR, imported from Strapi and honored by the Strapi target

**Files:**
- Modify: `packages/ir-schema/src/document.ts`, `packages/adapter-strapi/src/import/import-document.ts`, `packages/adapter-strapi/src/import/schema.ts`, `packages/adapter-strapi/src/generate.ts`, `packages/adapter-strapi/src/component-schema.ts`
- Test: `packages/ir-schema/src/document.test.ts`, `packages/adapter-strapi/src/import/import-document.test.ts`, `packages/adapter-strapi/src/generate.test.ts`

**Interfaces:**
- Produces: `Component.names?: { collection?: string; group?: string }`. Importer: `group` = the folder under `src/components/`, `collection` = the file's `collectionName`. Generator: component file path `src/components/${names.group ?? "shared"}/${kebab(name)}.json`, `collectionName` = `names.collection ?? components_shared_<snake plural>` (existing default). Round trip: importing a Strapi project and regenerating it reproduces its component folders and table names.

- [ ] **Step 1: Failing tests**

`document.test.ts`: `component.safeParse({ name: "Money", fields: [...], names: { collection: "components_finance_money", group: "finance" } }).success === true`; a component without `names` still parses.

`import-document.test.ts`:

```ts
it("imports component group and collectionName into names", () => {
  const r = importDocument([{ path: "src/components/finance/money.json", content: JSON.stringify({
    collectionName: "components_finance_money", info: { displayName: "Money" },
    attributes: { minor: { type: "biginteger" }, currency: { type: "string" } },
  }) }]).document;
  expect(r.ok && r.value.components[0]?.names).toEqual({ collection: "components_finance_money", group: "finance" });
});
```

`generate.test.ts` (adapter-strapi): a component with `names` is written to `src/components/finance/money.json` with `collectionName: "components_finance_money"`; one without keeps `src/components/shared/…` and the default collectionName (byte-identical goldens prove it).

- [ ] **Step 2: Run red** — `pnpm --filter @camis/ir-schema test && pnpm --filter @camis/adapter-strapi test`.

- [ ] **Step 3: Implement**

`document.ts`: add to `component`: `names: z.object({ collection: z.string().optional(), group: z.string().optional() }).optional()`.

`import-document.ts`: change `COMPONENT_RE` to `/(?:^|\/)src\/components\/([^/]+)\/([^/]+)\.json$/` and call `irComponent(pascal(m[2]!), parsed, m[1]!)`.

`schema.ts` `irComponent(componentName, schema, group?: string)`: build `names` from `str(schema.collectionName)` and `group` when present (omit keys that are empty; omit `names` entirely when both absent, so existing tests stay byte-identical).

`generate.ts` `componentFile`: path folder `component.names?.group ?? "shared"`. `component-schema.ts`: `collectionName: component.names?.collection ?? \`components_shared_${snakeCase(pluralize(component.name))}\``.

- [ ] **Step 4: Run green** — all three packages; `pnpm -r test` green; no golden changed.

- [ ] **Step 5: Commit** — `feat(ir-schema,adapter-strapi): Component.names round-trips Strapi component folders and table names`.

---

### Task 3: Strapi target — users-permissions grants at bootstrap

Today the Strapi target's permission emission targets admin roles only. For a generated Strapi project to accept API registration and content writes (needed by the cross-check and by any headless use), its bootstrap must also grant users-permissions actions.

**Files:**
- Modify: `packages/adapter-strapi/src/skeleton/templates.ts` (`PERMISSIONS_INDEX_TS`), `packages/adapter-strapi/src/permissions/emit.ts`, `packages/adapter-strapi/src/permissions/project.ts`
- Test: `packages/adapter-strapi/src/permissions/golden.test.ts` (+ golden), `project.test.ts`

**Interfaces:**
- Produces: `src/permissions/api-roles.json` = `{ roles: [{ type: "<camis role name>", actions: ["api::note.note.find", …] }], public: ["plugin::users-permissions.auth.register", "plugin::users-permissions.auth.callback"] }`; action mapping per grant action: `read → find, findOne`; `create → create`; `update → update`; `delete → delete`; `publish` → no users-permissions action (downgrade gap `publishAction`). The bootstrap ensures a `plugin::users-permissions.role` with that `type` exists (creating it with `name = type` if missing — Strapi ships `authenticated` and `public`) and creates missing `plugin::users-permissions.permission` rows for it, idempotently.

- [ ] **Step 1: Failing tests** — `project.test.ts`: `projectApiRoles(doc, roles)` for the permissions fixture yields `{ type: "Editor", actions: ["api::article.article.find", "api::article.article.findOne", "api::article.article.update"] }` and the public list; golden test for the new `src/index.ts` content (bootstrap now has both admin and users-permissions loops).

- [ ] **Step 2: Run red.**

- [ ] **Step 3: Implement** — `project.ts` gains `projectApiRoles(doc, roles): { roles: { type: string; actions: string[] }[]; public: string[] }` using `strapiNames(ct).uid`; `emit.ts` writes `src/permissions/api-roles.json` and the extended `PERMISSIONS_INDEX_TS`:

```ts
import apiRoles from "./permissions/api-roles.json";
// … inside bootstrap, after the admin loop:
    const grant = async (type: string, actions: string[]) => {
      let role = await strapi.query("plugin::users-permissions.role").findOne({ where: { type } });
      if (!role) role = await strapi.query("plugin::users-permissions.role").create({ data: { name: type, type, description: "camis" } });
      for (const action of actions) {
        const existing = await strapi.query("plugin::users-permissions.permission").findOne({ where: { action, role: role.id } });
        if (!existing) await strapi.query("plugin::users-permissions.permission").create({ data: { action, role: role.id } });
      }
    };
    await grant("public", apiRoles.public);
    for (const r of apiRoles.roles) await grant(r.type, r.actions);
```

(Strapi's users-permissions JWT strategy does not fall back to public grants for a bearer request — mirror OYL's `src/index.ts` by also granting `public` actions to every listed role when they are needed by authenticated clients; for register/callback that is not needed.)

- [ ] **Step 4: Run green; goldens regenerated and read; `pnpm -r test`.**

- [ ] **Step 5: Commit** — `feat(adapter-strapi): grant users-permissions API roles at bootstrap`.

---

### Task 4: Config, kernel option, scaffold `--storage strapi`

**Files:**
- Modify: `packages/adapter-kernel/src/types.ts`, `packages/cli/src/config.ts`, `packages/cli/src/run.ts`, `packages/cli/src/commands/generate.ts`, `packages/cli/src/commands/scaffold.ts`
- Test: `packages/cli/src/config.test.ts`, `packages/cli/src/commands/scaffold.test.ts`, `generate.test.ts`

**Interfaces:**
- Produces: `StorageLayout = "laravel" | "strapi"`; `GenerateOptions.storageLayout?: StorageLayout`; `TargetConfig.storageLayout?`; `loadConfig` rejects `storageLayout: "strapi"` without `apiStyle: "strapi"` (`error: "targets.<i>: storageLayout \"strapi\" requires apiStyle \"strapi\""`); `generateCommand` passes it through; `camis scaffold filament <dir> --storage strapi` runs `composer create-project laravel/laravel:^12`, `composer require firebase/php-jwt visus/cuid2 --no-interaction`, and nothing else (no Filament, no Spatie, no `install:api`, no User patch).

- [ ] **Step 1: Failing tests** — config accepts/rejects as above; scaffold test with the fake `Io` asserts the exec sequence for `--storage strapi` is exactly the two composer commands and no `writeFile` of `User.php`; the default sequence is unchanged.

- [ ] **Step 2: Run red.** - [ ] **Step 3: Implement** (`run.ts`: `flag(rest, "--storage", "laravel")` for `scaffold`; `scaffoldCommand(target, dir, io, { storage })`). - [ ] **Step 4: Green; `pnpm -r test`.** - [ ] **Step 5: Commit** — `feat(cli,adapter-kernel): storageLayout option and scaffold --storage strapi`.

---

### Task 5: Strapi physical names and the component map

**Files:**
- Create: `packages/adapter-filament/src/strapi-api/storage/names.ts`, `component-map.ts`, `__fixtures__/storage.ts`
- Test: `storage/names.test.ts`, `storage/component-map.test.ts`

**Interfaces:**
- Fixture `storageBundle: IrBundle`: builtin `User`; `Note` (recordId, text, occurredAt, `owner` manyToOne → User, plural `Notes`, `names.collection: "notes"`); `Transaction` with non-repeatable `Money` (`names: { collection: "components_finance_money", group: "finance" }`); `ActivitySession` with repeatable `Quantity` (`components_activity_quantities`, `activity`); `Consumable` with `creator` and non-repeatable `Facts` (`components_nutrition_nutrition_facts`, `nutrition`) containing non-repeatable `ServingSize` and repeatable `Nutrient` (`components_nutrition_additional_nutrients`); `Task` with `assignee` manyToOne → User **with `inverse: "tasks"`** (exercises `_ord`); roles as in Phase 16's fixture plus a grant for `Task`; `defaultRole: "authenticated"`.
- `names.ts`:
  ```ts
  export const strapiTable = (ct: ContentType): string;                       // names.collection ?? snake plural
  export const strapiSingular = (ct: ContentType): string;                     // snake(ct.name)
  export const linkTable = (ct: ContentType, relation: string): string;        // `${table}_${snake(relation)}_lnk`
  export const linkColumns = (ct: ContentType, f: RelationField): { local: string; foreign: string; ord?: string };
      // local `${singular}_id`, foreign `user_id` (target builtin user), ord `${singular}_ord` iff f.inverse
  export const cmpsTable = (table: string): string;                            // `${table}_cmps`
  export const componentTable = (c: Component): string;                        // names.collection ?? `components_shared_${snake(plural)}`
  export const componentType = (c: Component): string;                         // `${names.group ?? "shared"}.${kebab(c.name)}`
  ```
- `component-map.ts`:
  ```ts
  export interface MappedScalar { wireKey: string[]; flatAttribute: string; column: string; type: FieldType }
  export interface MappedComponent {
    field: string;              // IR field name on the owner ("amount", "facts", "additional")
    wireKey: string[];          // camelCase path from the content type root
    flatPrefix: string[];       // snake path prefix used by Phase 16 flattening (non-repeatable only)
    relationName?: string;      // Phase 16 child relation name (repeatable only), e.g. "factsAdditional"
    repeatable: boolean;
    table: string; type: string;   // component table, component_type
    cmpsTable: string;          // link table on the OWNER (content table or parent component table)
    scalars: MappedScalar[];    // column = snake(field), flatAttribute = Phase 16 attribute name or child column
    nested: MappedComponent[];
  }
  export const componentMap = (doc: IrDocument, ct: ContentType): MappedComponent[];
  ```
  Rules: a non-repeatable's scalars get `flatAttribute = [...flatPrefix, field].join("_")`; a repeatable's scalars get `flatAttribute = snake(field)` (child column names) and the repeatable gets `relationName = camelPath(path)` matching `childTableEmit`; nesting recurses with `cmpsTable = ${componentTable}_cmps`; a repeatable inside a repeatable is skipped (kernel already gaps it).

- [ ] **Step 1: Failing tests** — for the fixture: `strapiTable(Transaction) === "transactions"`, `linkTable(Note,"owner") === "notes_owner_lnk"`, `linkColumns(Task, assignee).ord === "task_ord"`, `linkColumns(Note, owner).ord === undefined`, `componentTable(Money) === "components_finance_money"`, `componentType(Facts) === "nutrition.nutrition-facts"`; `componentMap(Consumable)` yields `facts` (non-repeatable, table `components_nutrition_nutrition_facts`, `cmpsTable "consumables_cmps"`, scalars `calories` → flat `facts_calories`) with `nested` = `servingSize` (flat `facts_serving_size_amount`, `cmpsTable "components_nutrition_nutrition_facts_cmps"`) and `additional` (repeatable, `relationName "factsAdditional"`, scalars `slug`/`amount` flat `slug`/`amount`).

- [ ] **Step 2: Red. Step 3: Implement. Step 4: Green. Step 5: Commit** — `feat(adapter-filament): strapi storage names and component map`.

---

### Task 6: Emitted PHP runtime — `StrapiDateTime`, `StrapiRows`, `StrapiComponents`, `StrapiComponentAttributes`, `StrapiJwtGuard`

**Files:**
- Create: `packages/adapter-filament/src/strapi-api/storage/runtime.ts`
- Test: `storage/runtime.test.ts` + goldens `__golden__/storage/{StrapiDateTime,StrapiRows,StrapiComponents,StrapiComponentAttributes,StrapiJwtGuard}.php`

**Interfaces:**
- `emitStrapiDateTime(): string` — `App\Casts\StrapiDateTime implements CastsAttributes`: `get` returns `Carbon` from an int (ms) or string; `set` returns `(int) ($value->getTimestampMs())` when `DB::connection()->getDriverName() === 'sqlite'`, else `$value->utc()->format('Y-m-d H:i:s.u')`; null passes through.
- `emitStrapiRows(): string` — `App\Support\StrapiRows`: `create(Model $m): void` (fills `document_id` = `(string) new \Visus\Cuid2\Cuid2(24)`, `published_at = now()`, `locale = null`, saves); `link(Model $m, string $table, string $local, string $foreign, int $id, ?string $ord): void` (insert; `ord` = `max(ord)+1` when given); `unlinkAll(Model $m, string $table, string $local): void`.
- `emitStrapiComponents(): string` — `App\Support\StrapiComponents` with `load(Collection $rows, array $map): void`, `loadOne(Model $m, array $map): void`, `apply(Model $m, array $map, array $wire): array` (returns the non-component columns), `deleteAll(Model $m, array $map): void`; `$map` is the per-model PHP array literal generated in Task 7 from `MappedComponent[]` (keys: `field, wireKey, flatPrefix, relationName, repeatable, table, type, cmpsTable, scalars: [[column, flatAttribute, type]], nested`). `load` batches: one `_cmps` query per (owner table, field set), one query per component table, recursion for nested; it stores results in `$m->strapiComponents` (a public array `flatAttribute => value`) and `setRelation(relationName, Collection<stdClass with child columns>)` for repeatables. `apply` deletes and re-inserts the fields present in `$wire['columns']`/`$wire['children']`, with `order` for repeatables, recursing.
- `emitStrapiComponentAttributes(): string` — trait `App\Support\StrapiComponentAttributes`: `public array $strapiComponents = []; public function getAttribute($key) { if (array_key_exists($key, $this->strapiComponents)) return $this->strapiComponents[$key]; if (in_array($key, static::COMPONENT_ATTRIBUTES, true)) { StrapiComponents::loadOne($this, static::COMPONENT_MAP); return $this->strapiComponents[$key] ?? null; } return parent::getAttribute($key); }` plus the same lazy path for repeatable relations in `getRelationValue`.
- `emitStrapiJwtGuard(): string` — `App\Http\Middleware\StrapiJwtGuard`: reads `Bearer`, `JWT::decode($token, new Key(config('camis.jwt_secret'), 'HS256'))`, loads `User::find($payload->id)`, 401 `UnauthorizedError` if missing/blocked/expired, `$request->setUserResolver(fn () => $user)`.

- [ ] **Step 1: Failing golden tests** for the five emitters (assert marker, namespace, and one behavioral substring each — e.g. `getDriverName() === 'sqlite'`, `new \Visus\Cuid2\Cuid2(24)`, `'HS256'`, `array_key_exists($key, $this->strapiComponents)`).
- [ ] **Step 2: Red. Step 3: Write the emitters** (PHP as specified; keep each file focused; `php -l` all five). **Step 4: Green, idempotent. Step 5: Commit** — `feat(adapter-filament): strapi storage PHP runtime (dates, rows, components, jwt guard)`.

---

### Task 7: Storage-layout models (content types + `User`)

**Files:**
- Create: `packages/adapter-filament/src/strapi-api/storage/model.ts`
- Test: `storage/model.test.ts` + goldens `__golden__/storage/{Note,Consumable,Task,User}.model.php`

**Interfaces:**
- `emitStorageModel(ct: ContentType, doc: IrDocument, map: MappedComponent[], scopeMethod: string | undefined): string` — `App\Models\<Type>`: `use StrapiComponentAttributes;` `$table` = `strapiTable(ct)`; `$fillable` = real scalar columns + `document_id, published_at, locale`; `casts()` with `StrapiDateTime::class` for `created_at`, `updated_at`, `published_at` and every `dateTime`/`timestamp` field, `'array'` for json, `'boolean'` for boolean; `public const COMPONENT_ATTRIBUTES = [...]` (all `flatAttribute`s of non-repeatables) and `public const COMPONENT_MAP = [...]` (the array literal from the map); for each owning relation `public function owner(): BelongsToMany { return $this->belongsToMany(User::class, 'notes_owner_lnk', 'note_id', 'user_id'); }` and `public function getOwnerIdAttribute(): ?int { return $this->owner->first()?->id; }`; the repeatables' relation names are NOT Eloquent relations (they are set by the loader), so no method is emitted for them; `scopeForUser` spliced when given.
- `emitStorageUserModel(): string` — `App\Models\User extends Authenticatable` on `up_users`; `$fillable` `username, email, password, provider, confirmed, blocked, document_id, published_at, locale`; `$hidden` `password`; casts `confirmed/blocked => 'boolean'`, datetimes `StrapiDateTime`; `public function roles(): BelongsToMany` through `up_users_role_lnk(user_id, role_id)` to an emitted `App\Models\UpRole` (`$table = 'up_roles'`); `public function roleType(): ?string { return $this->roles->first()?->type; }`.

- [ ] **Step 1: Failing golden tests** (Note: belongsToMany + accessor + casts + consts; Consumable: nested map literal; Task: `task_ord` nowhere in the model — ord is a write concern — but the map is correct; User: `up_users`, `roleType`). Assert `php -l` clean.
- [ ] **Step 2–5** as usual; commit `feat(adapter-filament): strapi storage models`.

---

### Task 8: List scope through link tables

**Files:**
- Modify: `packages/adapter-filament/src/strapi-api/query-ast.ts`, `render-eloquent.ts`, `render-sql.ts`, `scope.ts`
- Test: `query-ast.test.ts`, `query-conformance.test.ts`, `scope.test.ts`

**Interfaces:**
- `WhereContext.columns` entries gain optional `link?: { table: string; local: string; foreign: string; owner: string }` (owner = content table). `whereContext(ct, layout: "laravel" | "strapi" = "laravel")` sets `link` for relation keys in the strapi layout. `WhereNode` `eq` gains optional `link` copied from the entry. `renderEloquent`: an `eq` with `link` renders `$q->whereExists(function ($s) use ($user) { $s->selectRaw('1')->from('notes_owner_lnk')->whereColumn('notes_owner_lnk.note_id', 'notes.id')->where('notes_owner_lnk.user_id', $user->id); });` (`orWhereExists` at `or` positions); `renderSql` renders `EXISTS (SELECT 1 FROM notes_owner_lnk WHERE notes_owner_lnk.note_id = notes.id AND notes_owner_lnk.user_id = 7)`. `emitScopeMethod(ct, condition, layout)`.

- [ ] **Step 1: Failing tests** — AST/renderer string assertions for `Note` in the strapi layout; a conformance case in `query-conformance.test.ts` creating `notes` + `notes_owner_lnk` in SQLite and asserting the `EXISTS` form selects exactly the evaluator's rows (a note with two owners must still count once; a note with no link row is excluded).
- [ ] **Step 2–5**; commit `feat(adapter-filament): list scopes through Strapi link tables`.

---

### Task 9: Controllers, routes, and policies for the layout

**Files:**
- Modify: `packages/adapter-filament/src/strapi-api/controller.ts` (`ControllerSpec.layout?: "laravel" | "strapi"`, `map?: MappedComponent[]`, `links?: { relation; table; local; foreign; ord? }[]`), `routes.ts` (`emitStrapiRoutes(cts, secured, guard: "auth:sanctum" | "strapi-jwt")`), `packages/adapter-filament/src/permissions/policy.ts` (`emitPolicy(spec, ct, layout)`)
- Test: `controller.test.ts`, `permissions/policy.test.ts` (+ goldens `__golden__/storage/Generated.NoteApiController.php`, `NotePolicy.storage.php`, `routes.storage.api.php`)

**Interfaces / emitted behavior in the strapi layout:**
- `scoped()`: `Note::query()->forUser($user)->with(['owner'])`.
- `index()`: after `->get()`, `StrapiComponents::load($rows, Note::COMPONENT_MAP);` before filtering/serializing.
- `store()`: `if (Note::query()->where(self::KEY, $wire['columns'][self::KEY] ?? null)->exists()) { throw ValidationException::withMessages([self::KEY => 'This attribute must be unique']); }` when `KEY !== 'id'`; then `DB::transaction`: `$m = new Note($columns = StrapiComponents::apply($m, Note::COMPONENT_MAP, $wire))` — order: `$m = new Note(); $m->fill(StrapiComponents::columnsOf($wire, Note::COMPONENT_MAP)); StrapiRows::create($m); StrapiRows::link($m, 'notes_owner_lnk', 'note_id', 'user_id', $request->user()->id, null); StrapiComponents::apply($m, Note::COMPONENT_MAP, $wire);` — 201.
- `update()`: found branch `DB::transaction { $m->fill(columnsOf(...))->save(); apply(...) }`; create branch = store's body with the key pinned — 200.
- `destroy()`: `DB::transaction { StrapiComponents::deleteAll($m, MAP); StrapiRows::unlinkAll($m, 'notes_owner_lnk', 'note_id'); $m->delete(); }`.
- `find()`/`show()` unchanged except `->with([...])`.
- Routes: the sanctum group becomes `Route::middleware(StrapiJwtGuard::class)` and the `use` line is added; `/users/me` unchanged.
- Policies (strapi layout): `$user->can('<key>')` → `in_array($user->roleType(), [<roles holding key>], true)`; `'user.role' => $user->roleType()`; record view uses `$record->ownerId` (accessor) instead of `$record->owner_id`.

- [ ] **Step 1: Failing goldens/assertions** (controller: `StrapiRows::create`, `link(`, `whereExists` not in controller, `ValidationException` on duplicate key, `deleteAll`; routes: `StrapiJwtGuard::class`; policy: `roleType()`, `$record->ownerId`). Laravel-layout goldens must stay byte-identical (assert `emitGeneratedController(spec)` without `layout` equals the pre-change output via existing goldens).
- [ ] **Step 2–5**; commit `feat(adapter-filament): strapi storage controllers, jwt-guarded routes, role-type policies`.

---

### Task 10: JWT `AuthController` and `config/camis.php` additions

**Files:**
- Create: `packages/adapter-filament/src/strapi-api/storage/auth.ts`
- Modify: `packages/adapter-filament/src/strapi-api/routes.ts` (`emitApiConfig(layout)` adds `'jwt_secret' => env('JWT_SECRET')`, `'email_confirmation' => (bool) env('CAMIS_EMAIL_CONFIRMATION', false)`)
- Test: `storage/auth.test.ts` + golden `__golden__/storage/AuthController.php`

**Interfaces:**
- `emitStorageAuthController(defaultRole: string | undefined): string` — `register`: validate; reject existing email/username with `ValidationException` (400) using Strapi's messages ("Email or Username are already taken"); `$user = new User([...]); $user->provider='local'; $user->confirmed = ! config('camis.email_confirmation'); $user->blocked=false; StrapiRows::create($user);` then link the role: `$role = UpRole::query()->where('type', '<defaultRole>')->firstOrFail(); StrapiRows::link($user, 'up_users_role_lnk', 'user_id', 'role_id', $role->id, 'user_ord');`; respond `{ jwt, user }`. `login`: email-first lookup, `Hash::check`, then `blocked` → 400 "Your account has been blocked by an administrator", `! confirmed` → 400 "Your account email is not confirmed"; `me` unchanged. `session()`: `JWT::encode(['id' => $user->id, 'iat' => $now, 'exp' => $now + 30*86400], config('camis.jwt_secret'), 'HS256')`.

- [ ] **Step 1: Failing golden + assertions** (`JWT::encode(`, `'HS256'`, `'user_ord'`, both Strapi messages, `email_confirmation`). - [ ] **Step 2–5**; commit `feat(adapter-filament): strapi-compatible JWT auth controller`.

---

### Task 11: Schema-check command, orchestration, generate branch

**Files:**
- Create: `packages/adapter-filament/src/strapi-api/storage/schema-check.ts`, `storage/emit.ts`
- Modify: `packages/adapter-filament/src/strapi-api/emit.ts` (delegate when layout is strapi), `packages/adapter-filament/src/generate.ts` (skip migrations, resources, child models, Spatie seeder, username migration; include `app/Support/Ring1.php` when policies have conditions), `packages/cli/README.md` (Task 13 covers docs; only the file-listing golden here)
- Test: `storage/generate-storage.test.ts` + goldens `__golden__/storage/file-listing.txt`, `CamisStrapiSchemaCheck.php`

**Interfaces:**
- `emitSchemaCheck(expected: Record<string, string[]>): string` — `App\Console\Commands\CamisStrapiSchemaCheck` (`signature 'camis:strapi-schema-check'`) iterating `Schema::hasTable`/`hasColumn`, printing each missing item, `return self::FAILURE` if any. `expectedSchema(doc, emitted): Record<string, string[]>` — content tables (real columns + `id, document_id, created_at, updated_at, published_at, locale`), link tables, `_cmps` tables, component tables (+ nested `_cmps`), `up_users`, `up_roles`, `up_users_role_lnk`.
- `emitStrapiStorage(input: StrapiApiInput): StrapiApiEmission` — the layout's full file set: models (+ `User`, `UpRole`), runtime files, serializers, controllers (base + seed), routes, `config/camis.php`, `AuthController`, `StrapiErrors`, schema-check command, `DEPLOY.md` variant paragraph ("Strapi owns the schema: boot Strapi against this database before the first deploy and after each schema change; run `php artisan camis:strapi-schema-check`"). Gaps: `manyToMany`/`oneToMany` owners, `media`, `dynamicZone` → `error`; `draftPublish` → `downgrade`; Filament resources → one `downgrade` gap `adminPanelNotEmitted`.
- `generate.ts`: `const storage = options.storageLayout ?? "laravel"`; when `strapi`: per content type emit only the storage model (with the scope method); skip migrations, resources, child models, laravel controllers; call `emitStrapiStorage` instead of `emitStrapiApi`; `emitPermissions` emits policies (layout-aware) and `Ring1.php` but NOT the seeder.

- [ ] **Step 1: Failing tests** — `filamentAdapter.generate(storageBundle, { projectName: "oyl", apiStyle: "strapi", storageLayout: "strapi" })`: file-listing golden (no `database/migrations/*`, no `app/Filament/*`, no seeder, has `app/Models/User.php`, `app/Models/UpRole.php`, `app/Console/Commands/CamisStrapiSchemaCheck.php`, `app/Support/Strapi*.php`, `app/Casts/StrapiDateTime.php`, `app/Http/Middleware/StrapiJwtGuard.php`); gaps contain exactly one `adminPanelNotEmitted`; `storageLayout` absent ⇒ deep-equal to the current strapi-api output (assert against the existing `strapiApiBundle` result); `generate(catalog, {})` deep-equals `generate(catalog, { storageLayout: "laravel" })`.
- [ ] **Step 2–5**; commit `feat(adapter-filament): storageLayout strapi orchestration and schema-check command`.

---

### Task 12: Cross-backend CI job

**Files:**
- Create: `packages/cli/scripts/strapi-storage-crosscheck.ts`, `.github/workflows/strapi-storage-crosscheck.yml`
- Modify: `packages/cli/package.json` (`"crosscheck": "tsx scripts/strapi-storage-crosscheck.ts"`)

**Interfaces:**
- The script (Node 20, PHP 8.3 + composer on PATH, runs only in the gated job): generates the Strapi project from `storageBundle` (import `strapiAdapter`; `materialize` to a temp dir; `npm install`; `npm run develop` with `DATABASE_CLIENT=sqlite`, `DATABASE_FILENAME=<abs>/shared.db`, `JWT_SECRET=crosscheck`, `APP_KEYS`, etc. as `apps/e2e-oyl/scripts/start-backend.mjs` does); waits for `/_health`; via REST: registers `alice`, creates one Note, one Transaction (with `amount`), one ActivitySession (two quantities), one Consumable (facts with servingSize and two additional nutrients); records the Strapi JWT; kills Strapi. Then scaffolds the PHP app (`camis scaffold filament <dir> --storage strapi` — or the same composer steps inline), materializes `filamentAdapter.generate(storageBundle, { apiStyle: "strapi", storageLayout: "strapi" })`, writes `.env` with `DB_CONNECTION=sqlite`, `DB_DATABASE=<abs>/shared.db`, `JWT_SECRET=crosscheck`, runs `php artisan camis:strapi-schema-check` (must pass), serves on 8765, and asserts: `GET /api/_health` 204; Strapi's JWT accepted on `/api/users/me` (username alice); each row reads back with the expected wire shape (deep-compare against what Strapi returned, ignoring `id`/`documentId`/timestamps); `PUT /api/notes/n2` creates a note; `POST /api/auth/local` returns a PHP JWT; kill PHP; boot Strapi again on the same file; `GET /api/notes` with the PHP JWT returns both notes with `n2` present and `GET /api/users/me` accepts it. Exit non-zero on any mismatch, printing the first diff.
- Workflow: `workflow_dispatch` + nightly, Node 20 + PHP 8.3 (`shivammathur/setup-php` with `pdo_sqlite`), `pnpm install`, `pnpm --filter @camis/cli crosscheck`.

- [ ] **Step 1: Write the script and workflow** (the script is not unit-tested; `pnpm --filter @camis/cli typecheck` covers it). - [ ] **Step 2: Run it locally** (composer + php present; the Strapi `npm install` takes several minutes) until it prints `CROSSCHECK OK`; fix emitters TDD-style (owning test file first) for every divergence; record each in the commit messages. - [ ] **Step 3: Commit** — `test(cli): strapi storage cross-backend check`.

---

### Task 13: Docs

- `packages/cli/README.md`: `storageLayout` bullet (requires `apiStyle: strapi`; Strapi owns the schema; what is and is not emitted; `camis:strapi-schema-check`; `JWT_SECRET`, `CAMIS_EMAIL_CONFIRMATION`; scaffold `--storage strapi`); `Component.names`; users-permissions grants on the Strapi target.
- `docs/PLAN.md` Phase 17 exit criteria: mark the cross-check job as the gate.
- Commit `docs: Phase 17 storage layout`.

---

## Self-review

**Spec coverage:** 17a → Task 2; 17b → Task 7 (+ scope splice in 11); 17c/17d → Tasks 6, 9; 17e → Task 8; 17f → Task 9 (store) and 10 (register); 17g → Tasks 6 (guard), 10 (controller), 9 (routes); 17h → Task 9 (policy); 17i → Task 6; 17j → Task 11; 17k → Task 4; camis cross-check → Task 12 (with Task 3 making the generated Strapi project usable); the nested-repeatable prerequisite → Task 1. The oyl side (config flip, `E2E_STORAGE=strapi`, deploy schema check, DreamHost sync docs) is a separate plan.

**Placeholder scan:** Tasks 6, 7, 9, 10 give the emitted PHP by contract and named substrings rather than full listings — deliberate because the storage runtime is ~400 lines of PHP whose exact text the implementer derives from the interfaces above and Strapi's verified layout; every behavior is stated, and Task 12 is the executable oracle. No "TBD"/"similar to" remain.

**Type consistency:** `MappedComponent`/`MappedScalar` (5) consumed by 6 (array literal contract), 7 (`COMPONENT_MAP`), 9, 11; `strapiTable/linkTable/linkColumns/componentTable/componentType` (5) used by 7, 8, 11; `emitStrapiRoutes(cts, secured, guard)` (9) used by 11; `emitApiConfig(layout)` (10) used by 11; `GenerateOptions.storageLayout` (4) read in 11 and passed by the cross-check (12).
