# Phase 6B — Filament Breadth: Full Field Taxonomy + Relations Design

**Status:** approved design, pre-implementation
**Phase:** PLAN.md Phase 6, sub-phase B (of A/B/C)
**Scope:** extend `@camis/adapter-filament` (built in 6A) from the scalar subset to the **full IR
field taxonomy** and to **relations** (all four kinds → Eloquent relationships + foreign-key/pivot
migrations + owning-side Filament `Select`). `component` and `dynamicZone` fields are reported as
**capability-gaps** (deferred). Filament relation managers are deferred. Permissions remain 6C.

---

## 1. Context & goal

6A proved camis can generate a bootable Laravel 12 + Filament v5 app for one content type with
scalar fields. 6B adds the breadth that makes the target genuinely useful: every remaining field
type and the relational model. The work is **purely additive** — 6A's `Article` (scalar) goldens
stay byte-identical as a regression check; 6B introduces a richer fixture for the new coverage.
Phase 6's exit criteria (Article + a permission condition) are met by 6A+6C; 6B is the
breadth between them.

## 2. Settled decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Components + dynamicZone → capability-gap** (`downgrade`, located). | No native Eloquent/Filament analog for components; not in Phase 6 exit criteria; keeps 6B focused. dynamicZone is gapped everywhere already. |
| D2 | **Relations: Eloquent methods (4 kinds) + FK/pivot migrations + owning-side Filament `Select`.** Relation managers (hasMany/hasOne inverse UI) deferred. | Covers real relational modeling and the form UX for owning relations; the gated boot job validates migrate+boot. Relation managers are additive UI for later. |
| D3 | **Explicit FK/pivot arguments in every emitted relationship method** — never rely on Laravel's name-based inference. | Inference derives the FK from the *method name*; a differently-named inverse field would produce a mismatched FK. Explicit args (`belongsTo(Author::class, 'author_id')`) are deterministic and correct. |
| D4 | **Portable column types for the sqlite/mysql/pgsql requirement:** `enumeration` → `string` (NOT `$table->enum()`); `media` → `string` (single) / `json` (multiple); `decimal` → Laravel default precision. | `$table->enum()` behaves inconsistently across the three databases; `string`/`json` migrate cleanly everywhere. |
| D5 | **Relation `use` imports + `casts()` entries are emitted conditionally** (only when the model actually has relationships / typed fields). | Keeps 6A's `Article` model golden byte-identical (no unused imports) and avoids empty `casts()`. |
| D6 | **6B adds a NEW richer fixture** (relations + full field types) used for the new goldens AND pointed at by `scripts/overlay.ts`; the 6A `blog`/`Article` fixture and goldens are untouched (regression). | The gated boot job must exercise FKs + pivot tables; the 6A goldens remain a stable regression check. |
| D7 | **`oneToOne` convention: the declaring owner holds the FK** (`belongsTo(..., '<fk>')` + a `unique()` FK column); the synthesized inverse side gets `hasOne`. | Deterministic FK placement; symmetric kinds need a fixed rule. Mirrors the owner-declares model used throughout the IR. |

## 3. Full field taxonomy (`fields.ts`)

The single mapping table (driving migration column + form component + table column + optional cast)
gains every remaining scalar/semi-scalar type. `relation` is routed to the relations module (§4);
`component`/`dynamicZone` are gaps (§6).

| IR type | migration | form component | table column | cast |
|---------|-----------|----------------|--------------|------|
| string | `string('<c>')` | `TextInput` | `TextColumn` | — |
| text | `text('<c>')` | `Textarea` | `TextColumn` | — |
| richText | `longText('<c>')` | `RichEditor` | `TextColumn` | — |
| email | `string('<c>')` | `TextInput->email()` | `TextColumn` | — |
| uid | `string('<c>')` | `TextInput` | `TextColumn` | — |
| integer | `integer('<c>')` | `TextInput->numeric()` | `TextColumn` | — |
| bigInteger | `bigInteger('<c>')` | `TextInput->numeric()` | `TextColumn` | — |
| float | `float('<c>')` | `TextInput->numeric()` | `TextColumn` | — |
| decimal | `decimal('<c>')` | `TextInput->numeric()` | `TextColumn` | `decimal:2` |
| boolean | `boolean('<c>')` | `Toggle` | `IconColumn->boolean()` | `boolean` |
| enumeration | `string('<c>')` | `Select->options([...])` | `TextColumn` | — |
| date | `date('<c>')` | `DatePicker` | `TextColumn->date()` | `date` |
| time | `time('<c>')` | `TimePicker` | `TextColumn` | — |
| dateTime | `dateTime('<c>')` | `DateTimePicker` | `TextColumn->dateTime()` | `datetime` |
| timestamp | `timestamp('<c>')` | `DateTimePicker` | `TextColumn->dateTime()` | `datetime` |
| json | `json('<c>')` | `KeyValue` | `TextColumn` | `array` |
| media | `string`/`json('<c>')` | `FileUpload` (`->multiple()`) | `TextColumn` | (`array` if multiple) |

**Constraints:** `required` → migration omits `->nullable()` + form `->required()`; `unique` →
migration `->unique()` + form `->unique()`; `default` → migration `->default(...)`; enumeration
`values` → `Select->options([...])` (PHP assoc array value=>label); `maxLength` → `string('<c>', <n>)`.
(Numeric `min`/`max` bounds map to Filament validation in a later polish; not required for 6B.)

## 4. Relations (`relations.ts` — new; mirrors Strapi's `synthesizedInverses`)

`resolveRelations(doc)` walks every relation field and produces a structure the emitters consume:
- **per content type:** owner relationship methods + owner FK migration columns;
- **injected onto targets:** the synthesized inverse relationship method (dual kind) and, for
  `oneToMany`, the FK column on the target's table (when the owner sets `inverse`);
- **pivot tables:** one per `manyToMany` pair, deduped, Laravel-convention alphabetical singular
  snake name (`article_tag`), with two explicit FK columns.

The dual map (reused from the IR semantics): `oneToOne↔oneToOne`, `oneToMany↔manyToOne`,
`manyToMany↔manyToMany`.

| IR kind (owner) | owner Eloquent method | owner migration | synthesized inverse |
|-----------------|----------------------|-----------------|---------------------|
| `manyToOne` | `belongsTo(Target::class, '<fk>')` | `foreignId('<fk>')->constrained('<table>')` (`->nullable()` if not required) | `hasMany(Owner::class, '<fk>')` |
| `oneToOne` | `belongsTo(Target::class, '<fk>')` | `foreignId('<fk>')->unique()->constrained('<table>')` | `hasOne(Owner::class, '<fk>')` |
| `oneToMany` | `hasMany(Target::class, '<fk>')` | *(FK injected on target's table)* | `belongsTo(Owner::class, '<fk>')` + FK on target |
| `manyToMany` | `belongsToMany(Target::class, '<pivot>', '<ownerFk>', '<targetFk>')` | *(pivot table)* | `belongsToMany(Owner::class, '<pivot>', '<targetFk>', '<ownerFk>')` |

**FK naming:** `<fk> = snakeColumn(relationFieldName) + '_id'` for the owning belongsTo side;
for `oneToMany`, the FK on the target is `snakeColumn(inverseFieldName) + '_id'` (the inverse
belongsTo method name). All FK args are emitted **explicitly** (D3). Relationship **method names** =
the IR field name (owner) and the `inverse` field name (target).

## 5. Emitter extensions

- **`model.ts`** — accepts injected relationship methods (own + synthesized inverse); emits the
  methods with their return-type `use` imports (`Illuminate\Database\Eloquent\Relations\{BelongsTo,
  HasOne,HasMany,BelongsToMany}`), conditionally (only when present, D5). Extends `casts()` for the
  new typed fields, conditionally.
- **`migration.ts`** — handles all new column types (§3); appends owner FK columns; accepts injected
  FK columns (oneToMany on target); emits **separate pivot-table migrations** with deterministic
  ordinals AFTER the content-type migrations, in stable (sorted) order. All column types portable
  across the three databases (D4).
- **`resource.ts`** — new form components + table columns per §3; for owning relations emits
  `Select::make('<fk>')->relationship(name: '<field>', titleAttribute: 'id')` (belongsTo /
  oneToOne) and `Select::make('<field>')->multiple()->relationship(titleAttribute: 'id')`
  (manyToMany). Inverse hasMany/hasOne sides get no form field (relation managers deferred, D2).

## 6. Generate orchestration (`generate.ts`)

Per field: a supported scalar/semi-scalar → column/form/table via `fields.ts`; a `relation` → the
`resolveRelations` pass; `component` or `dynamicZone` → a `downgrade` `CapabilityGap`
(`{ contentType, field }` located, message naming the unsupported construct). Assemble each content
type's model/migration/Resource (with injected relation methods + FK columns), then the pivot-table
migrations, then `buildManifest`, then the gap report.

## 7. Determinism

Stable ordering everywhere: injected relationship methods and FK columns sorted by a stable key;
pivot tables alphabetical; migration ordinals = content types in document order, then pivots in
sorted order. PSR-12 stable formatting; no timestamps. Idempotent regeneration (second run = no
diff) asserted.

## 8. Testing

- **`fields.ts`:** a unit test per new field type (migration/form/table/cast fragment) + constraint
  tests (required/unique/default/enum options/maxLength).
- **`relations.ts`:** each kind resolves to the correct owner method + FK/pivot + synthesized
  inverse method/FK (explicit args verified); bidirectional pairing; pivot dedup + alphabetical
  naming.
- **Golden:** a richer fixture (e.g. `Author hasMany Article` bidirectional with `Article belongsTo
  Author`; `Article belongsToMany Tag`; plus enum/media/json/date/richText fields) — model,
  migrations (incl. pivot), Resource/Form/Table byte-locked; idempotent. A component/dynamicZone gap
  test asserts the located downgrade entries.
- **6A regression:** the existing `Article` scalar goldens remain byte-identical.
- **Gated boot:** `scripts/overlay.ts` is pointed at the new richer fixture so the
  `adapter-filament-boot` job migrates FKs + pivot tables and boots on sqlite/mysql/pgsql.

## 9. Exit criteria (6B)

- Full field taxonomy + all four relation kinds (Eloquent methods + FK/pivot migrations + owning
  Filament `Select`) generate golden-locked and idempotent output.
- `component` and `dynamicZone` are reported as capability-gaps, not silently dropped.
- The gated `adapter-filament-boot` job migrates + boots the richer fixture on sqlite/mysql/pgsql.
- 6A `Article` goldens unchanged; `pnpm lint` / `pnpm -r typecheck` / `pnpm -r test` green.

## 10. Cross-cutting

- The IR stays the single source of truth; all Eloquent/Filament/Blueprint specifics are confined
  to `adapter-filament`. No sibling-adapter imports; no `any` in package sources.
- One-way authoritative generation; nothing parses generated PHP back into IR.
- Determinism (explicit FK args, sorted injection, ordinal migrations, no timestamps) keeps goldens
  and idempotent regen stable.
- Portability (D4) is a first-class constraint: every emitted column type must migrate on all three
  databases — validated by the gated boot matrix.
