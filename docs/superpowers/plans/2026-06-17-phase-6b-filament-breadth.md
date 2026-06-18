# Phase 6B — Filament Breadth (Field Taxonomy + Relations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `@camis/adapter-filament` from the scalar subset to the full IR field taxonomy and to relations (all four kinds → Eloquent relationships + foreign-key/pivot migrations + owning-side Filament `Select`), with `component`/`dynamicZone` reported as capability-gaps.

**Architecture:** `fields.ts` becomes the single source for complete migration/form/table expressions (type + constraints). A new `relations.ts` resolves relations into per-model methods, per-table FK columns, and pivot tables (with synthesized inverses, mirroring the Strapi adapter). The model/migration/resource emitters accept injected relation data; `generate.ts` orchestrates. Golden + structural per commit; the gated 3-DB boot job validates migrate+boot on a relation-bearing fixture.

**Tech Stack:** TypeScript (strict, ESM), Vitest (`toMatchFileSnapshot`), emitted PHP for Laravel 12 + Filament `^5.0`.

**Design spec:** `docs/superpowers/specs/2026-06-17-phase-6b-filament-breadth-design.md`

> **Golden note:** snapshots record emitter output (generate with `-u`); the gated `adapter-filament-boot` job is the authoritative validator of real Filament/Laravel v5 correctness + 3-DB portability. 6A's `Article` goldens must remain BYTE-IDENTICAL (regression) — verify, never `-u` them.

---

## File structure

- `packages/adapter-filament/src/fields.ts` — MODIFY: full type map; `emitField` returns COMPLETE migration/form/table expressions (constraints applied); add `isSupportedField`.
- `packages/adapter-filament/src/migration.ts` — MODIFY: consume complete column exprs; accept injected FK columns; add `emitPivotMigration`.
- `packages/adapter-filament/src/resource.ts` — MODIFY: consume complete form/table exprs; accept injected relation `Select` form fields.
- `packages/adapter-filament/src/model.ts` — MODIFY: accept injected relationship methods (+ imports).
- `packages/adapter-filament/src/relations.ts` — CREATE: `resolveRelations(doc)`.
- `packages/adapter-filament/src/generate.ts` — MODIFY: orchestrate relations + pivots + component/dynamicZone gaps.
- `packages/adapter-filament/src/__fixtures__/catalog.ts` — CREATE: richer fixture (relations + full types).
- `packages/adapter-filament/scripts/overlay.ts` — MODIFY: point at `catalog`.
- Tests + `__golden__/*` per task.

---

## Task 1: Full field taxonomy + centralized constraints (`fields.ts`)

`emitField` now returns the COMPLETE migration column expression (type + nullable/unique/default/length) and the COMPLETE form component (type + required/unique/options) so the emitters stop appending suffixes. This keeps one source of truth and — verified in this task — leaves 6A's `Article` goldens byte-identical.

**Files:** Modify `packages/adapter-filament/src/fields.ts`, `packages/adapter-filament/src/migration.ts`, `packages/adapter-filament/src/resource.ts`; Test `packages/adapter-filament/src/fields.test.ts` (extend).

- [ ] **Step 1: Replace `fields.ts`** with the full map + complete-expression builder:
```ts
import type { Field } from "@camis/ir-schema";
import { snakeColumn } from "./names";

export interface FieldEmit {
  column: string;
  migration: string; // complete: $table->...(...)->nullable()->unique()->default(...)
  formComponent: string; // complete: TextInput::make('c')->required()
  tableColumn: string;
  formImport: string;
  tableImport: string;
  cast?: string;
}

const TEXT_INPUT = "Filament\\Forms\\Components\\TextInput";
const TEXT_COLUMN = "Filament\\Tables\\Columns\\TextColumn";

// Supported non-relation field types in 6B (relation is handled by relations.ts; component/dynamicZone are gaps).
const SUPPORTED = new Set<string>([
  "string", "text", "richText", "email", "uid", "integer", "bigInteger", "float", "decimal",
  "boolean", "enumeration", "date", "time", "dateTime", "timestamp", "json", "media",
]);
export const isSupportedField = (t: string): boolean => SUPPORTED.has(t);

const phpDefault = (v: unknown): string =>
  typeof v === "boolean" ? (v ? "true" : "false") : typeof v === "number" ? JSON.stringify(v) : `'${String(v)}'`;

interface Base {
  migration: string;
  formComponent: string;
  tableColumn: string;
  formImport: string;
  tableImport: string;
  cast?: string;
}

const base = (field: Field, c: string): Base => {
  const f = field as Field & Record<string, unknown>;
  const maxLen = typeof f.maxLength === "number" ? `, ${f.maxLength}` : "";
  switch (field.type) {
    case "string":
    case "uid":
    case "email":
      return {
        migration: `$table->string('${c}'${maxLen})`,
        formComponent: `TextInput::make('${c}')${field.type === "email" ? "->email()" : ""}`,
        tableColumn: `TextColumn::make('${c}')`,
        formImport: TEXT_INPUT,
        tableImport: TEXT_COLUMN,
      };
    case "text":
      return { migration: `$table->text('${c}')`, formComponent: `Textarea::make('${c}')`, tableColumn: `TextColumn::make('${c}')`, formImport: "Filament\\Forms\\Components\\Textarea", tableImport: TEXT_COLUMN };
    case "richText":
      return { migration: `$table->longText('${c}')`, formComponent: `RichEditor::make('${c}')`, tableColumn: `TextColumn::make('${c}')`, formImport: "Filament\\Forms\\Components\\RichEditor", tableImport: TEXT_COLUMN };
    case "integer":
    case "bigInteger":
    case "float":
      return { migration: `$table->${field.type === "bigInteger" ? "bigInteger" : field.type}('${c}')`, formComponent: `TextInput::make('${c}')->numeric()`, tableColumn: `TextColumn::make('${c}')`, formImport: TEXT_INPUT, tableImport: TEXT_COLUMN };
    case "decimal":
      return { migration: `$table->decimal('${c}')`, formComponent: `TextInput::make('${c}')->numeric()`, tableColumn: `TextColumn::make('${c}')`, formImport: TEXT_INPUT, tableImport: TEXT_COLUMN, cast: "'decimal:2'" };
    case "boolean":
      return { migration: `$table->boolean('${c}')`, formComponent: `Toggle::make('${c}')`, tableColumn: `IconColumn::make('${c}')->boolean()`, formImport: "Filament\\Forms\\Components\\Toggle", tableImport: "Filament\\Tables\\Columns\\IconColumn", cast: "'boolean'" };
    case "enumeration": {
      const values = (f.values as string[] | undefined) ?? [];
      const opts = values.map((v) => `'${v}' => '${v}'`).join(", ");
      return { migration: `$table->string('${c}')`, formComponent: `Select::make('${c}')->options([${opts}])`, tableColumn: `TextColumn::make('${c}')`, formImport: "Filament\\Forms\\Components\\Select", tableImport: TEXT_COLUMN };
    }
    case "date":
      return { migration: `$table->date('${c}')`, formComponent: `DatePicker::make('${c}')`, tableColumn: `TextColumn::make('${c}')->date()`, formImport: "Filament\\Forms\\Components\\DatePicker", tableImport: TEXT_COLUMN, cast: "'date'" };
    case "time":
      return { migration: `$table->time('${c}')`, formComponent: `TimePicker::make('${c}')`, tableColumn: `TextColumn::make('${c}')`, formImport: "Filament\\Forms\\Components\\TimePicker", tableImport: TEXT_COLUMN };
    case "dateTime":
    case "timestamp":
      return { migration: `$table->${field.type === "timestamp" ? "timestamp" : "dateTime"}('${c}')`, formComponent: `DateTimePicker::make('${c}')`, tableColumn: `TextColumn::make('${c}')->dateTime()`, formImport: "Filament\\Forms\\Components\\DateTimePicker", tableImport: TEXT_COLUMN, cast: "'datetime'" };
    case "json":
      return { migration: `$table->json('${c}')`, formComponent: `KeyValue::make('${c}')`, tableColumn: `TextColumn::make('${c}')`, formImport: "Filament\\Forms\\Components\\KeyValue", tableImport: TEXT_COLUMN, cast: "'array'" };
    case "media": {
      const multiple = f.multiple === true;
      return { migration: `$table->${multiple ? "json" : "string"}('${c}')`, formComponent: `FileUpload::make('${c}')${multiple ? "->multiple()" : ""}`, tableColumn: `TextColumn::make('${c}')`, formImport: "Filament\\Forms\\Components\\FileUpload", tableImport: TEXT_COLUMN, ...(multiple ? { cast: "'array'" } : {}) };
    }
    default:
      // Unreachable for supported types; relation/component/dynamicZone are routed elsewhere.
      return { migration: `$table->string('${c}')`, formComponent: `TextInput::make('${c}')`, tableColumn: `TextColumn::make('${c}')`, formImport: TEXT_INPUT, tableImport: TEXT_COLUMN };
  }
};

export const emitField = (field: Field): FieldEmit => {
  const f = field as Field & Record<string, unknown>;
  const column = snakeColumn(field.name);
  const b = base(field, column);
  const required = f.required === true;
  const unique = f.unique === true;
  const migration =
    b.migration +
    (required ? "" : "->nullable()") +
    (unique ? "->unique()" : "") +
    (f.default !== undefined ? `->default(${phpDefault(f.default)})` : "");
  const formComponent = b.formComponent + (required ? "->required()" : "") + (unique ? "->unique()" : "");
  return { column, migration, formComponent, tableColumn: b.tableColumn, formImport: b.formImport, tableImport: b.tableImport, ...(b.cast ? { cast: b.cast } : {}) };
};
```

- [ ] **Step 2: Simplify `migration.ts`** — change the `columns` mapping to consume the complete expression (remove the inline `->nullable()`):
```ts
  const columns = ct.fields
    .map(emitField)
    .map((e) => `            ${e.migration};`)
    .join("\n");
```
(Leave the rest of `emitMigration` unchanged for now; injected FK columns + pivots come in Task 4.)

- [ ] **Step 3: Simplify `resource.ts`** — change `formBody` to consume the complete form component (remove the inline `->required()`):
```ts
  const formBody = emits.map((e) => `            ${e.formComponent},`).join("\n");
```
(`tableBody` is unchanged.)

- [ ] **Step 4: Extend `fields.test.ts`** — append cases for the new types/constraints:
```ts
it("maps enumeration to a Select with options and a string column", () => {
  const f = emitField({ type: "enumeration", name: "status", values: ["draft", "published"] } as Field);
  expect(f.migration).toBe("$table->string('status')->nullable()");
  expect(f.formComponent).toBe("Select::make('status')->options(['draft' => 'draft', 'published' => 'published'])");
});
it("applies required, unique, and default to the migration", () => {
  const f = emitField({ type: "string", name: "slug", required: true, unique: true, default: "x" } as Field);
  expect(f.migration).toBe("$table->string('slug')->unique()->default('x')");
  expect(f.formComponent).toBe("TextInput::make('slug')->required()->unique()");
});
it("maps json/media/richText/decimal", () => {
  expect(emitField({ type: "json", name: "meta" } as Field).cast).toBe("'array'");
  expect(emitField({ type: "media", name: "cover", multiple: true } as Field).migration).toBe("$table->json('cover')->nullable()");
  expect(emitField({ type: "richText", name: "body" } as Field).formComponent).toBe("RichEditor::make('body')");
  expect(emitField({ type: "decimal", name: "price" } as Field).cast).toBe("'decimal:2'");
});
```
Keep the existing 6A `emitField` tests; UPDATE the `isScalar6A` test to `isSupportedField` (`expect(isSupportedField("string")).toBe(true); expect(isSupportedField("relation")).toBe(false); expect(isSupportedField("component")).toBe(false)`). Remove the now-defunct `isScalar6A` import.

- [ ] **Step 5: Run + verify 6A goldens UNCHANGED** —
```bash
pnpm --filter @camis/adapter-filament exec vitest run src/fields.test.ts src/migration.test.ts src/resource.test.ts src/golden.test.ts
```
All pass with NO snapshot writes. CRITICAL: `git status` must show no change under `src/__golden__/` (the `Article` goldens are byte-identical). If a golden changed, the centralization altered output — fix `emitField`/emitters to match, do NOT `-u`. Then `pnpm --filter @camis/adapter-filament typecheck`.
Note: `generate.ts` still imports `isScalar6A` — it will break compile until Task 6. To keep this task self-contained and green, in `generate.ts` replace `isScalar6A(f.type)` with `!isSupportedField(f.type) && f.type !== "relation"` and import `isSupportedField` (relation handling lands in Task 6; for now relation still falls through to the gap, which is acceptable mid-refactor since no fixture uses relations yet). Update the gap message to drop "Phase 6A". Run `pnpm --filter @camis/adapter-filament test` — all green.

- [ ] **Step 6: Commit**
```bash
git add packages/adapter-filament/src/fields.ts packages/adapter-filament/src/migration.ts packages/adapter-filament/src/resource.ts packages/adapter-filament/src/fields.test.ts packages/adapter-filament/src/generate.ts
git commit -m "feat(adapter-filament): full field taxonomy + centralized constraints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Relation resolution (`relations.ts`)

Resolves every relation field into Eloquent methods, FK migration columns, owning-side `Select` form fields, and pivot tables — with synthesized inverses on target types. All FK/pivot args are explicit.

**Files:** Create `packages/adapter-filament/src/relations.ts`, `packages/adapter-filament/src/relations.test.ts`.

- [ ] **Step 1: Failing test** `packages/adapter-filament/src/relations.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { resolveRelations } from "./relations";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [
      { type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" },
      { type: "relation", name: "tags", relationKind: "manyToMany", target: "Tag", inverse: "articles" },
    ] },
    { name: "Author", kind: "collection", fields: [] },
    { name: "Tag", kind: "collection", fields: [] },
  ],
  components: [],
};

describe("resolveRelations", () => {
  const r = resolveRelations(doc);
  it("emits an explicit belongsTo on the owner and FK column", () => {
    expect(r.methods.get("Article")!.some((m) => m.php.includes("belongsTo(Author::class, 'author_id')"))).toBe(true);
    expect(r.fkColumns.get("Article")!.some((c) => c.includes("foreignId('author_id')->constrained('authors')"))).toBe(true);
    expect(r.formFields.get("Article")!.some((s) => s.includes("Select::make('author_id')->relationship(name: 'author'"))).toBe(true);
  });
  it("synthesizes a hasMany inverse on the target", () => {
    expect(r.methods.get("Author")!.some((m) => m.php.includes("hasMany(Article::class, 'author_id')"))).toBe(true);
  });
  it("emits a deduped pivot for manyToMany with explicit keys on both sides", () => {
    expect(r.pivots.map((p) => p.table)).toEqual(["article_tag"]);
    expect(r.methods.get("Article")!.some((m) => m.php.includes("belongsToMany(Tag::class, 'article_tag', 'article_id', 'tag_id')"))).toBe(true);
    expect(r.methods.get("Tag")!.some((m) => m.php.includes("belongsToMany(Article::class, 'article_tag', 'tag_id', 'article_id')"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run red:** `pnpm --filter @camis/adapter-filament exec vitest run src/relations.test.ts`.

- [ ] **Step 3: Implement** `packages/adapter-filament/src/relations.ts`:
```ts
import type { ContentType, IrDocument, RelationKind } from "@camis/ir-schema";
import { filamentNames, snake, snakeColumn } from "./names";

const REL_NS = "Illuminate\\Database\\Eloquent\\Relations";

export interface RelationMethod { import: string; php: string }
export interface PivotTable { table: string; leftTable: string; rightTable: string; leftFk: string; rightFk: string }
export interface ResolvedRelations {
  methods: Map<string, RelationMethod[]>;
  formFields: Map<string, string[]>;
  fkColumns: Map<string, string[]>;
  pivots: PivotTable[];
}

const push = <V>(m: Map<string, V[]>, k: string, v: V): void => {
  const a = m.get(k) ?? [];
  a.push(v);
  m.set(k, a);
};

const belongsToMethod = (method: string, targetModel: string, fk: string): RelationMethod => ({
  import: `${REL_NS}\\BelongsTo`,
  php: `    public function ${method}(): BelongsTo\n    {\n        return $this->belongsTo(${targetModel}::class, '${fk}');\n    }`,
});
const hasManyMethod = (method: string, targetModel: string, fk: string): RelationMethod => ({
  import: `${REL_NS}\\HasMany`,
  php: `    public function ${method}(): HasMany\n    {\n        return $this->hasMany(${targetModel}::class, '${fk}');\n    }`,
});
const hasOneMethod = (method: string, targetModel: string, fk: string): RelationMethod => ({
  import: `${REL_NS}\\HasOne`,
  php: `    public function ${method}(): HasOne\n    {\n        return $this->hasOne(${targetModel}::class, '${fk}');\n    }`,
});
const belongsToManyMethod = (method: string, targetModel: string, pivot: string, fk: string, otherFk: string): RelationMethod => ({
  import: `${REL_NS}\\BelongsToMany`,
  php: `    public function ${method}(): BelongsToMany\n    {\n        return $this->belongsToMany(${targetModel}::class, '${pivot}', '${fk}', '${otherFk}');\n    }`,
});

export const resolveRelations = (doc: IrDocument): ResolvedRelations => {
  const out: ResolvedRelations = { methods: new Map(), formFields: new Map(), fkColumns: new Map(), pivots: [] };
  const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
  const seenPivot = new Set<string>();

  const names = (n: string): ReturnType<typeof filamentNames> => filamentNames(byName.get(n) as ContentType);
  const singular = (n: string): string => snake(n); // Article -> article

  for (const ct of doc.contentTypes) {
    for (const f of ct.fields) {
      if (f.type !== "relation") continue;
      const owner = ct.name;
      const target = f.target;
      const kind: RelationKind = f.relationKind;
      const ownerN = names(owner);
      const targetN = names(target);

      if (kind === "manyToOne" || kind === "oneToOne") {
        const fk = `${snakeColumn(f.name)}_id`;
        push(out.methods, owner, belongsToMethod(f.name, targetN.model, fk));
        const unique = kind === "oneToOne" ? "->unique()" : "";
        push(out.fkColumns, owner, `$table->foreignId('${fk}')${f.required === true ? "" : "->nullable()"}${unique}->constrained('${targetN.table}')`);
        push(out.formFields, owner, `Select::make('${fk}')->relationship(name: '${f.name}', titleAttribute: 'id')`);
        if (f.inverse !== undefined) {
          push(out.methods, target, kind === "oneToOne" ? hasOneMethod(f.inverse, ownerN.model, fk) : hasManyMethod(f.inverse, ownerN.model, fk));
        }
      } else if (kind === "oneToMany") {
        // FK lives on the target table; method name for the target's belongsTo = inverse (or owner singular).
        const inverseName = f.inverse ?? singular(owner);
        const fk = `${snakeColumn(inverseName)}_id`;
        push(out.methods, owner, hasManyMethod(f.name, targetN.model, fk));
        push(out.fkColumns, target, `$table->foreignId('${fk}')->nullable()->constrained('${ownerN.table}')`);
        if (f.inverse !== undefined) {
          push(out.methods, target, belongsToMethod(f.inverse, ownerN.model, fk));
          push(out.formFields, target, `Select::make('${fk}')->relationship(name: '${f.inverse}', titleAttribute: 'id')`);
        }
      } else {
        // manyToMany
        const a = singular(owner);
        const b = singular(target);
        const [left, right] = a < b ? [a, b] : [b, a];
        const pivot = `${left}_${right}`;
        const ownerFk = `${a}_id`;
        const targetFk = `${b}_id`;
        push(out.methods, owner, belongsToManyMethod(f.name, targetN.model, pivot, ownerFk, targetFk));
        push(out.formFields, owner, `Select::make('${f.name}')->multiple()->relationship(name: '${f.name}', titleAttribute: 'id')`);
        if (f.inverse !== undefined) {
          push(out.methods, target, belongsToManyMethod(f.inverse, ownerN.model, pivot, targetFk, ownerFk));
          push(out.formFields, target, `Select::make('${f.inverse}')->multiple()->relationship(name: '${f.inverse}', titleAttribute: 'id')`);
        }
        if (!seenPivot.has(pivot)) {
          seenPivot.add(pivot);
          out.pivots.push({ table: pivot, leftTable: names(a < b ? owner : target).table, rightTable: names(a < b ? target : owner).table, leftFk: `${left}_id`, rightFk: `${right}_id` });
        }
      }
    }
  }
  return out;
};
```
(Note: `f` is the relation field; access `f.relationKind`/`f.target`/`f.inverse`/`f.required` via the discriminated `Field` union — for `f.type === "relation"` TS narrows these. If `required`/`inverse` need a cast, use `(f as Field & { required?: boolean })`.)

- [ ] **Step 4: Run green:** `pnpm --filter @camis/adapter-filament exec vitest run src/relations.test.ts` (pass); `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/relations.ts packages/adapter-filament/src/relations.test.ts
git commit -m "feat(adapter-filament): relation resolution (Eloquent methods, FKs, pivots)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Model emitter — inject relationship methods

**Files:** Modify `packages/adapter-filament/src/model.ts`, `packages/adapter-filament/src/model.test.ts`.

- [ ] **Step 1: Failing test** — append to `model.test.ts`:
```ts
it("emits injected relationship methods and their imports", () => {
  const php = emitModel(article, [
    { import: "Illuminate\\Database\\Eloquent\\Relations\\BelongsTo", php: "    public function author(): BelongsTo\n    {\n        return $this->belongsTo(Author::class, 'author_id');\n    }" },
  ]);
  expect(php).toContain("use Illuminate\\Database\\Eloquent\\Relations\\BelongsTo;");
  expect(php).toContain("public function author(): BelongsTo");
});
```

- [ ] **Step 2: Run red:** `pnpm --filter @camis/adapter-filament exec vitest run src/model.test.ts`.

- [ ] **Step 3: Modify `emitModel`** signature + body in `model.ts`:
```ts
import type { ContentType } from "@camis/ir-schema";
import { emitField } from "./fields";
import { filamentNames } from "./names";
import type { RelationMethod } from "./relations";

export const emitModel = (ct: ContentType, relations: RelationMethod[] = []): string => {
  const names = filamentNames(ct);
  const emits = ct.fields.filter((f) => f.type !== "relation").map(emitField);
  const fillable = emits.map((e) => `        '${e.column}',`).join("\n");
  const casts = emits
    .filter((e) => e.cast !== undefined)
    .map((e) => `            '${e.column}' => ${e.cast},`)
    .join("\n");
  const castsMethod =
    casts.length > 0
      ? `\n    protected function casts(): array\n    {\n        return [\n${casts}\n        ];\n    }\n`
      : "";
  const relImports = [...new Set(relations.map((r) => r.import))].sort().map((i) => `use ${i};`).join("\n");
  const relUse = relImports ? `${relImports}\n` : "";
  const relMethods = relations.length > 0 ? `\n${relations.map((r) => r.php).join("\n\n")}\n` : "";
  return `<?php

declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;
${relUse}
class ${names.model} extends Model
{
    protected $table = '${names.table}';

    protected $fillable = [
${fillable}
    ];
${castsMethod}${relMethods}}
`;
};
```
Note: relation fields are excluded from `$fillable`/`casts` (they are not columns on this row except the FK, which is added by the migration, not mass-assignable here for 6B). The blank line after `use Model;` + `${relUse}` keeps the 6A model (no relations → `relUse=""`) byte-identical: with no relations, `${relUse}` is empty and the structure matches 6A exactly.

- [ ] **Step 4: Run green + 6A regression:** `pnpm --filter @camis/adapter-filament exec vitest run src/model.test.ts src/golden.test.ts`. The `Article` model golden MUST be unchanged (no `-u`); if it changed, adjust the `relUse`/blank-line handling to match 6A byte-for-byte. `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/model.ts packages/adapter-filament/src/model.test.ts
git commit -m "feat(adapter-filament): inject Eloquent relationship methods into models

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Migration emitter — injected FKs + pivot migrations

**Files:** Modify `packages/adapter-filament/src/migration.ts`, `packages/adapter-filament/src/migration.test.ts`.

- [ ] **Step 1: Failing test** — append to `migration.test.ts`:
```ts
import { emitPivotMigration, pivotMigrationFilename } from "./migration";

it("appends injected FK columns to a create migration", () => {
  const php = emitMigration(article, ["$table->foreignId('author_id')->nullable()->constrained('authors')"]);
  expect(php).toContain("$table->foreignId('author_id')->nullable()->constrained('authors');");
});
it("emits a pivot table migration", () => {
  const pivot = { table: "article_tag", leftTable: "articles", rightTable: "tags", leftFk: "article_id", rightFk: "tag_id" };
  expect(pivotMigrationFilename(pivot, 5)).toBe("database/migrations/0000_00_00_000005_create_article_tag_table.php");
  const php = emitPivotMigration(pivot);
  expect(php).toContain("Schema::create('article_tag', function (Blueprint $table): void {");
  expect(php).toContain("$table->foreignId('article_id')->constrained('articles')->cascadeOnDelete();");
  expect(php).toContain("$table->foreignId('tag_id')->constrained('tags')->cascadeOnDelete();");
});
```

- [ ] **Step 2: Run red:** `pnpm --filter @camis/adapter-filament exec vitest run src/migration.test.ts`.

- [ ] **Step 3: Modify `migration.ts`** — add `fkColumns` param to `emitMigration` and add the pivot emitters:
```ts
import type { ContentType } from "@camis/ir-schema";
import { emitField } from "./fields";
import { filamentNames } from "./names";
import type { PivotTable } from "./relations";

export const migrationFilename = (ct: ContentType, ordinal: number): string => {
  const table = filamentNames(ct).table;
  return `database/migrations/0000_00_00_${String(ordinal).padStart(6, "0")}_create_${table}_table.php`;
};

export const pivotMigrationFilename = (pivot: PivotTable, ordinal: number): string =>
  `database/migrations/0000_00_00_${String(ordinal).padStart(6, "0")}_create_${pivot.table}_table.php`;

export const emitMigration = (ct: ContentType, fkColumns: string[] = []): string => {
  const names = filamentNames(ct);
  const fieldCols = ct.fields
    .filter((f) => f.type !== "relation")
    .map(emitField)
    .map((e) => `            ${e.migration};`);
  const fkCols = fkColumns.map((c) => `            ${c};`);
  const columns = [...fieldCols, ...fkCols].join("\n");
  return `<?php

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('${names.table}', function (Blueprint $table): void {
            $table->id();
${columns}
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('${names.table}');
    }
};
`;
};

export const emitPivotMigration = (pivot: PivotTable): string => `<?php

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('${pivot.table}', function (Blueprint $table): void {
            $table->foreignId('${pivot.leftFk}')->constrained('${pivot.leftTable}')->cascadeOnDelete();
            $table->foreignId('${pivot.rightFk}')->constrained('${pivot.rightTable}')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('${pivot.table}');
    }
};
`;
```
The relation-field filter in `emitMigration` ensures relation fields don't double-emit columns (their FK arrives via `fkColumns`). For 6A's `Article` (no relations, empty `fkColumns`), output is byte-identical.

- [ ] **Step 4: Run green + 6A regression:** `pnpm --filter @camis/adapter-filament exec vitest run src/migration.test.ts src/golden.test.ts` — Article migration golden unchanged (no `-u`). `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/migration.ts packages/adapter-filament/src/migration.test.ts
git commit -m "feat(adapter-filament): injected FK columns + pivot table migrations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Resource emitter — inject relation Select fields

**Files:** Modify `packages/adapter-filament/src/resource.ts`, `packages/adapter-filament/src/resource.test.ts`.

- [ ] **Step 1: Failing test** — append to `resource.test.ts`:
```ts
it("appends injected relation Select form fields with the Select import", () => {
  const files = emitResourceFiles(article, ["Select::make('author_id')->relationship(name: 'author', titleAttribute: 'id')"]);
  const form = files.find((f) => f.path.endsWith("Schemas/ArticleForm.php"))!.content;
  expect(form).toContain("use Filament\\Forms\\Components\\Select;");
  expect(form).toContain("Select::make('author_id')->relationship(name: 'author', titleAttribute: 'id'),");
});
```

- [ ] **Step 2: Run red:** `pnpm --filter @camis/adapter-filament exec vitest run src/resource.test.ts`.

- [ ] **Step 3: Modify `emitResourceFiles`** — add a `relationFields: string[] = []` param; exclude relation fields from the scalar `emits`; append the relation `Select` strings (and the `Select` import) to the form body. Change the signature line and the `emits`/form construction:
```ts
export const emitResourceFiles = (ct: ContentType, relationFields: string[] = []): GeneratedFile[] => {
  const n = filamentNames(ct);
  const dir = `app/Filament/Resources/${n.resourceDir}`;
  const ns = `App\\Filament\\Resources\\${n.resourceDir}`;
  const emits = ct.fields.filter((f) => f.type !== "relation").map(emitField);
  // ... (page name derivation + resource string unchanged) ...
  const SELECT = "Filament\\Forms\\Components\\Select";
  const formImports = useBlock([
    ...emits.map((e) => e.formImport),
    ...(relationFields.length > 0 ? [SELECT] : []),
    "Filament\\Schemas\\Schema",
  ]);
  const formBody = [
    ...emits.map((e) => `            ${e.formComponent},`),
    ...relationFields.map((s) => `            ${s},`),
  ].join("\n");
  // ... (table + pages unchanged) ...
```
Keep everything else in the function as-is. Relation fields are excluded from the table columns in 6B (no relation table column; deferred). For 6A's `Article` (no relation fields), `relationFields=[]` → form/table identical.

- [ ] **Step 4: Run green + 6A regression:** `pnpm --filter @camis/adapter-filament exec vitest run src/resource.test.ts src/golden.test.ts` — Article Resource/Form/Table goldens unchanged (no `-u`). `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/resource.ts packages/adapter-filament/src/resource.test.ts
git commit -m "feat(adapter-filament): inject relation Select fields into Filament forms

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Generate orchestration — relations + pivots + gaps

**Files:** Modify `packages/adapter-filament/src/generate.ts`, `packages/adapter-filament/src/generate.test.ts`.

- [ ] **Step 1: Failing test** — extend `generate.test.ts` with a relation + gap bundle:
```ts
import type { IrBundle } from "@camis/permissions";

const relBundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      { name: "Article", kind: "collection", fields: [
        { type: "string", name: "title", required: true },
        { type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" },
        { type: "relation", name: "tags", relationKind: "manyToMany", target: "Tag", inverse: "articles" },
        { type: "component", name: "seo", component: "Seo", repeatable: false },
      ] },
      { name: "Author", kind: "collection", fields: [{ type: "string", name: "name", required: true }] },
      { name: "Tag", kind: "collection", fields: [{ type: "string", name: "label", required: true }] },
    ],
    components: [],
  },
  roles: [],
};

describe("filamentAdapter relations + gaps", () => {
  const result = filamentAdapter.generate(relBundle, { projectName: "blog" });
  const paths = result.files.map((f) => f.path);
  it("emits a pivot migration after the content-type migrations", () => {
    expect(paths).toContain("database/migrations/0000_00_00_000004_create_article_tag_table.php");
  });
  it("injects the author_id FK into the articles migration", () => {
    const mig = result.files.find((f) => f.path.endsWith("create_articles_table.php"))!.content;
    expect(mig).toContain("$table->foreignId('author_id')->nullable()->constrained('authors');");
  });
  it("reports the component field as a capability gap", () => {
    expect(result.gaps.gaps.some((g) => g.feature === "component" && g.location.field === "seo")).toBe(true);
  });
});
```

- [ ] **Step 2: Run red:** `pnpm --filter @camis/adapter-filament exec vitest run src/generate.test.ts`.

- [ ] **Step 3: Rewrite `generate.ts`** to orchestrate relations:
```ts
import {
  buildManifest,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap } from "@camis/ir-schema";
import { isSupportedField } from "./fields";
import { emitMigration, emitPivotMigration, migrationFilename, pivotMigrationFilename } from "./migration";
import { emitModel } from "./model";
import { filamentNames } from "./names";
import { resolveRelations } from "./relations";
import { emitResourceFiles } from "./resource";

export const filamentAdapter: GenerateAdapter = {
  target: "filament",
  generate: (ir): GenerationResult => {
    const doc = normalize(ir.document);
    const rel = resolveRelations(doc);
    const files: GeneratedFile[] = [];
    const gaps: CapabilityGap[] = [];

    doc.contentTypes.forEach((ct, i) => {
      for (const f of ct.fields) {
        if (f.type === "relation") continue;
        if (!isSupportedField(f.type)) {
          gaps.push({
            feature: f.type,
            location: { contentType: ct.name, field: f.name },
            severity: "downgrade",
            message: `field type "${f.type}" is not supported by the Filament target`,
          });
        }
      }
      const names = filamentNames(ct);
      files.push({ path: `app/Models/${names.model}.php`, content: emitModel(ct, rel.methods.get(ct.name) ?? []) });
      files.push({ path: migrationFilename(ct, i + 1), content: emitMigration(ct, rel.fkColumns.get(ct.name) ?? []) });
      files.push(...emitResourceFiles(ct, rel.formFields.get(ct.name) ?? []));
    });

    // Pivot migrations after content-type migrations, in stable (sorted) order.
    [...rel.pivots]
      .sort((a, b) => a.table.localeCompare(b.table))
      .forEach((p, j) => {
        files.push({ path: pivotMigrationFilename(p, doc.contentTypes.length + 1 + j), content: emitPivotMigration(p) });
      });

    return { files, manifest: buildManifest(files), gaps: { target: "filament", gaps } };
  },
};
```

- [ ] **Step 4: Run green:** `pnpm --filter @camis/adapter-filament exec vitest run src/generate.test.ts` (pass), then `pnpm --filter @camis/adapter-filament test` (WHOLE package green incl. 6A goldens unchanged), `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/generate.ts packages/adapter-filament/src/generate.test.ts
git commit -m "feat(adapter-filament): orchestrate relations, pivots, and component gaps

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Richer fixture + goldens

**Files:** Create `packages/adapter-filament/src/__fixtures__/catalog.ts`, `packages/adapter-filament/src/catalog-golden.test.ts`, and generated `src/__golden__/catalog/*`.

- [ ] **Step 1: Fixture** `packages/adapter-filament/src/__fixtures__/catalog.ts`:
```ts
import type { IrBundle } from "@camis/permissions";

export const catalog: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      { name: "Article", kind: "collection", fields: [
        { type: "string", name: "title", required: true },
        { type: "richText", name: "body" },
        { type: "enumeration", name: "status", values: ["draft", "published"] },
        { type: "json", name: "meta" },
        { type: "media", name: "cover" },
        { type: "dateTime", name: "publishedAt" },
        { type: "relation", name: "author", relationKind: "manyToOne", target: "Author", inverse: "articles" },
        { type: "relation", name: "tags", relationKind: "manyToMany", target: "Tag", inverse: "articles" },
      ] },
      { name: "Author", kind: "collection", fields: [
        { type: "string", name: "name", required: true },
        { type: "email", name: "email", unique: true },
      ] },
      { name: "Tag", kind: "collection", fields: [{ type: "string", name: "label", required: true }] },
    ],
    components: [],
  },
  roles: [],
};
```

- [ ] **Step 2: Golden test** `packages/adapter-filament/src/catalog-golden.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "./generate";
import { catalog } from "./__fixtures__/catalog";

describe("catalog golden", () => {
  const result = filamentAdapter.generate(catalog, { projectName: "blog" });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("Article model golden", async () => {
    await expect(content("app/Models/Article.php")).toMatchFileSnapshot("./__golden__/catalog/Article.model.php");
  });
  it("Author model golden", async () => {
    await expect(content("app/Models/Author.php")).toMatchFileSnapshot("./__golden__/catalog/Author.model.php");
  });
  it("articles migration golden", async () => {
    await expect(content("database/migrations/0000_00_00_000001_create_articles_table.php")).toMatchFileSnapshot("./__golden__/catalog/create_articles_table.php");
  });
  it("pivot migration golden", async () => {
    await expect(content("database/migrations/0000_00_00_000004_create_article_tag_table.php")).toMatchFileSnapshot("./__golden__/catalog/create_article_tag_table.php");
  });
  it("Article form golden", async () => {
    await expect(content("app/Filament/Resources/Articles/Schemas/ArticleForm.php")).toMatchFileSnapshot("./__golden__/catalog/ArticleForm.php");
  });
  it("file listing golden", async () => {
    await expect(result.files.map((f) => `${f.mode ?? "overwrite"} ${f.path}`).sort().join("\n")).toMatchFileSnapshot("./__golden__/catalog/file-listing.txt");
  });
  it("gap report is empty (no component/dynamicZone in fixture)", () => {
    expect(result.gaps.gaps).toEqual([]);
  });
  it("regeneration is idempotent", () => {
    expect(filamentAdapter.generate(catalog, { projectName: "blog" })).toEqual(result);
  });
});
```

- [ ] **Step 3: Generate + INSPECT** — `pnpm --filter @camis/adapter-filament exec vitest run src/catalog-golden.test.ts -u`. Read the generated files under `src/__golden__/catalog/`: confirm the Article model has `belongsTo(Author::class, 'author_id')` + `belongsToMany(Tag::class, 'article_tag', 'article_id', 'tag_id')` with `use …BelongsTo;`/`…BelongsToMany;`; the Author model has `hasMany(Article::class, 'author_id')` + `belongsToMany(...)`; the articles migration has the `author_id` FK; the pivot migration is well-formed; the Article form has `Select` fields for author + tags; richText/enum/json/media components present. If anything is structurally wrong, STOP and report (emitter bug) — do not hand-edit snapshots.

- [ ] **Step 4: Run green:** `pnpm --filter @camis/adapter-filament test` (all green, 6A goldens untouched), `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/__fixtures__/catalog.ts packages/adapter-filament/src/catalog-golden.test.ts packages/adapter-filament/src/__golden__/catalog
git commit -m "test(adapter-filament): catalog golden — relations, pivots, full field types

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Point boot overlay at the richer fixture + sweep

**Files:** Modify `packages/adapter-filament/scripts/overlay.ts`.

- [ ] **Step 1: Repoint overlay** — in `packages/adapter-filament/scripts/overlay.ts`, change the fixture import + usage from `blog` to `catalog`:
```ts
import { materialize } from "@camis/adapter-kernel";
import { filamentAdapter } from "../src/generate";
import { catalog } from "../src/__fixtures__/catalog";

const dest = process.argv[2];
if (!dest) {
  console.error("usage: tsx scripts/overlay.ts <laravel-app-dir>");
  process.exit(1);
}
await materialize(filamentAdapter.generate(catalog, { projectName: "blog" }), dest);
console.log(`overlay materialized into ${dest}`);
```
(The gated `adapter-filament-boot` workflow now migrates the relation FKs + pivot table on all three DBs — no workflow change needed; it already calls `pnpm --filter @camis/adapter-filament overlay`.)

- [ ] **Step 2: Full sweep** — run and report:
```bash
pnpm lint
pnpm -r typecheck
pnpm -r test
```
All green. The 6A `blog` fixture + its `golden.test.ts` remain (regression); `catalog` drives the new goldens + the boot overlay.

- [ ] **Step 3: Commit**
```bash
git add packages/adapter-filament/scripts/overlay.ts
git commit -m "ci(adapter-filament): boot overlay exercises relations + full types via catalog

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** D1 component/dynamicZone gap (Task 6) · D2 relations Eloquent+migration+Select, managers deferred (Tasks 2–6) · D3 explicit FK/pivot args (Task 2) · D4 portable column types — enum→string, media→string/json (Task 1) · D5 conditional relation `use`/casts (Tasks 1,3) · D6 new `catalog` fixture, 6A `blog` untouched (Tasks 7,8) · D7 oneToOne owner-FK belongsTo + hasOne inverse (Task 2). Exit criteria: full taxonomy + 4 relation kinds golden-locked + idempotent (Task 7); gaps (Task 6); gated boot via catalog (Task 8); 6A regression preserved (Steps "no -u" in Tasks 1,3,4,5).

**Placeholder scan:** none — concrete code throughout. Goldens generated via `-u` then inspected (Task 7). Task 5's resource modification references "unchanged" surrounding code shown in the 6A plan/source; the implementer is told exactly which lines change (signature, `emits` filter, `formImports`, `formBody`).

**Type consistency:** `FieldEmit` (Task 1) consumed by migration/resource/model. `RelationMethod`/`PivotTable`/`ResolvedRelations` (Task 2) consumed by model (`relations: RelationMethod[]`, Task 3), migration (`fkColumns: string[]` + `PivotTable`, Task 4), resource (`relationFields: string[]`, Task 5), generate (`rel.methods/.fkColumns/.formFields/.pivots`, Task 6). `emitModel(ct, relations?)`, `emitMigration(ct, fkColumns?)`, `emitResourceFiles(ct, relationFields?)`, `emitPivotMigration(pivot)`, `pivotMigrationFilename(pivot, ordinal)` — names consistent across definition (Tasks 3–4) and call sites (Task 6). `isSupportedField` replaces `isScalar6A` everywhere (Tasks 1,6).

**Risk note for implementers:** the centralization in Task 1 and the emitter-signature changes in Tasks 3–5 MUST keep the 6A `blog`/`Article` goldens byte-identical — every such task runs `golden.test.ts` WITHOUT `-u` and treats any golden diff as a bug to fix in the emitter, not a snapshot to rewrite. The relation FK-inference correctness and 3-DB portability are validated by the gated `adapter-filament-boot` job (the oracle), since no per-commit test executes PHP.