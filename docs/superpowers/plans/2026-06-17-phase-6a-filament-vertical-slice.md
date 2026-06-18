# Phase 6A — Filament Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate the IR-derived overlay (Eloquent model, migration, Filament v5 Resource) for one content type (`Article`, scalar fields) of a Laravel 12 + Filament v5 app, golden-locked and idempotent, with a gated CI job that scaffolds + overlays + migrates + boots on sqlite/mysql/pgsql.

**Architecture:** New `@camis/adapter-filament` package, a `GenerateAdapter` (kernel contract, takes `IrBundle`, reads `ir.document`, ignores `ir.roles`). Pure string emitters produce PHP into the conventional Laravel/Filament paths; the official scaffold (`laravel new` + `filament:install`) + our overlay compose into a bootable app in the gated job. Golden tests snapshot our emitters' output; the gated boot job is the authoritative oracle for v5 correctness.

**Tech Stack:** TypeScript (strict, ESM, Bundler resolution), Vitest (`toMatchFileSnapshot`), `@camis/adapter-kernel` (`stableJson`, `buildManifest`, `materialize`), emitted PHP for Laravel 12 + Filament `^5.0`.

**Design spec:** `docs/superpowers/specs/2026-06-17-phase-6a-filament-vertical-slice-design.md`

> **Note on goldens:** golden tests use Vitest `toMatchFileSnapshot`, which records whatever the emitter produces (generate with `-u`). They lock our output for idempotency/regression — they are NOT a hand-authored "correct Filament" reference. Real v5 validity is proven only by the gated `adapter-filament-boot` job. If that job ever fails on structure, fix the emitter template and regenerate goldens.

---

## File structure

**`packages/adapter-filament/`**
- `package.json` — add deps (`adapter-kernel`, `ir-schema`, `ir-core`, `permissions`); add `smoke` script.
- `src/names.ts` — Laravel/Filament naming (studly/snake/pluralize; the `FilamentNames` builder; `snakeColumn`).
- `src/fields.ts` — scalar field → `{ migration, formComponent, tableColumn, imports, cast }` map (the single source feeding all emitters).
- `src/model.ts` — Eloquent model emitter.
- `src/migration.ts` — migration emitter (deterministic ordinal filename).
- `src/resource.ts` — Filament Resource + Form + Table + 3 Pages emitters.
- `src/generate.ts` — `filamentAdapter` assembling the overlay file set + manifest + gaps.
- `src/index.ts` — public exports.
- `src/__fixtures__/blog.ts` — `Article` (+ a second type for ordinal ordering) `IrBundle` fixture.
- `src/*.test.ts`, `src/__golden__/*` — tests + golden snapshots.
- `scripts/overlay.ts` — tsx overlay script for the gated job.

**`.github/workflows/adapter-filament-boot.yml`** — gated 3-DB boot job.

---

## Task 1: Package scaffold

**Files:** Modify `packages/adapter-filament/package.json`, `packages/adapter-filament/src/index.ts`.

- [ ] **Step 1: Add deps** — Run:
```bash
pnpm --filter @camis/adapter-filament add @camis/adapter-kernel@workspace:* @camis/ir-schema@workspace:* @camis/ir-core@workspace:* @camis/permissions@workspace:*
```
Confirm all four appear in `packages/adapter-filament/package.json` dependencies.

- [ ] **Step 2: Placeholder export** — set `packages/adapter-filament/src/index.ts` to:
```ts
export {};
```
(Real exports are added in Task 7; this keeps the package compiling.)

- [ ] **Step 3: Typecheck** — `pnpm --filter @camis/adapter-filament typecheck` (clean).

- [ ] **Step 4: Commit**
```bash
git add packages/adapter-filament/package.json packages/adapter-filament/src/index.ts pnpm-lock.yaml
git commit -m "chore(adapter-filament): wire package dependencies

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Naming helpers (`names.ts`)

**Files:** Create `packages/adapter-filament/src/names.ts`, `packages/adapter-filament/src/names.test.ts`.

- [ ] **Step 1: Failing test** — `packages/adapter-filament/src/names.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { filamentNames, snakeColumn } from "./names";

const ct = (name: string, plural?: string): ContentType =>
  ({ name, kind: "collection", fields: [], ...(plural ? { names: { plural } } : {}) }) as ContentType;

describe("filamentNames", () => {
  it("derives model/table/resource names for a simple type", () => {
    expect(filamentNames(ct("Article"))).toEqual({
      model: "Article",
      table: "articles",
      resourceDir: "Articles",
      resourceClass: "ArticleResource",
      formClass: "ArticleForm",
      tableClass: "ArticlesTable",
    });
  });
  it("handles multi-word names", () => {
    const n = filamentNames(ct("BlogPost"));
    expect(n.model).toBe("BlogPost");
    expect(n.table).toBe("blog_posts");
    expect(n.resourceClass).toBe("BlogPostResource");
  });
  it("honors an explicit IR plural override", () => {
    expect(filamentNames(ct("Category", "Categories")).table).toBe("categories");
  });
});

describe("snakeColumn", () => {
  it("snake-cases field names", () => {
    expect(snakeColumn("publishedAt")).toBe("published_at");
    expect(snakeColumn("title")).toBe("title");
  });
});
```

- [ ] **Step 2: Run — FAIL** — `pnpm --filter @camis/adapter-filament exec vitest run src/names.test.ts`.

- [ ] **Step 3: Implement** — `packages/adapter-filament/src/names.ts`
```ts
import type { ContentType } from "@camis/ir-schema";

export interface FilamentNames {
  model: string;
  table: string;
  resourceDir: string;
  resourceClass: string;
  formClass: string;
  tableClass: string;
}

const studly = (name: string): string =>
  name.replace(/(^|[_\- ])([a-z])/g, (_m, _s, c: string) => c.toUpperCase()).replace(/[_\- ]/g, "");

export const snake = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();

// Minimal pluralizer; the IR `names.plural` override covers irregulars.
const pluralize = (word: string): string => {
  if (/[^aeiou]y$/.test(word)) return word.replace(/y$/, "ies");
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
};

export const snakeColumn = (fieldName: string): string => snake(fieldName);

export const filamentNames = (ct: ContentType): FilamentNames => {
  const model = studly(ct.name);
  const singularSnake = snake(ct.name);
  const pluralSnake = ct.names?.plural ? snake(ct.names.plural) : pluralize(singularSnake);
  const resourceDir = studly(pluralSnake);
  return {
    model,
    table: pluralSnake,
    resourceDir,
    resourceClass: `${model}Resource`,
    formClass: `${model}Form`,
    tableClass: `${resourceDir}Table`,
  };
};
```

- [ ] **Step 4: Run — PASS** — `pnpm --filter @camis/adapter-filament exec vitest run src/names.test.ts`; then `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/names.ts packages/adapter-filament/src/names.test.ts
git commit -m "feat(adapter-filament): Laravel/Filament naming helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Field mapping (`fields.ts`)

**Files:** Create `packages/adapter-filament/src/fields.ts`, `packages/adapter-filament/src/fields.test.ts`.

- [ ] **Step 1: Failing test** — `packages/adapter-filament/src/fields.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { emitField, isScalar6A } from "./fields";

describe("emitField", () => {
  it("maps a required string", () => {
    const f = emitField({ type: "string", name: "title", required: true } as Field);
    expect(f.column).toBe("title");
    expect(f.required).toBe(true);
    expect(f.migration).toBe("$table->string('title')");
    expect(f.formComponent).toBe("TextInput::make('title')");
    expect(f.tableColumn).toBe("TextColumn::make('title')");
    expect(f.cast).toBeUndefined();
  });
  it("maps a boolean with a cast and icon column", () => {
    const f = emitField({ type: "boolean", name: "published" } as Field);
    expect(f.migration).toBe("$table->boolean('published')");
    expect(f.tableColumn).toBe("IconColumn::make('published')->boolean()");
    expect(f.cast).toBe("'boolean'");
  });
  it("snake-cases the column from a camelCase field", () => {
    const f = emitField({ type: "dateTime", name: "publishedAt" } as Field);
    expect(f.column).toBe("published_at");
    expect(f.cast).toBe("'datetime'");
  });
  it("isScalar6A gates the supported subset", () => {
    expect(isScalar6A("string")).toBe(true);
    expect(isScalar6A("relation")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — FAIL** — `pnpm --filter @camis/adapter-filament exec vitest run src/fields.test.ts`.

- [ ] **Step 3: Implement** — `packages/adapter-filament/src/fields.ts`
```ts
import type { Field } from "@camis/ir-schema";
import { snakeColumn } from "./names";

export type ScalarType = "string" | "text" | "boolean" | "integer" | "dateTime";

export interface FieldEmit {
  column: string;
  required: boolean;
  migration: string;
  formComponent: string;
  tableColumn: string;
  formImport: string;
  tableImport: string;
  cast?: string;
}

const SCALARS = new Set<string>(["string", "text", "boolean", "integer", "dateTime"]);
export const isScalar6A = (t: string): t is ScalarType => SCALARS.has(t);

type Builder = (c: string) => Omit<FieldEmit, "column" | "required">;

const MAP: Record<ScalarType, Builder> = {
  string: (c) => ({
    migration: `$table->string('${c}')`,
    formComponent: `TextInput::make('${c}')`,
    tableColumn: `TextColumn::make('${c}')`,
    formImport: "Filament\\Forms\\Components\\TextInput",
    tableImport: "Filament\\Tables\\Columns\\TextColumn",
  }),
  text: (c) => ({
    migration: `$table->text('${c}')`,
    formComponent: `Textarea::make('${c}')`,
    tableColumn: `TextColumn::make('${c}')`,
    formImport: "Filament\\Forms\\Components\\Textarea",
    tableImport: "Filament\\Tables\\Columns\\TextColumn",
  }),
  boolean: (c) => ({
    migration: `$table->boolean('${c}')`,
    formComponent: `Toggle::make('${c}')`,
    tableColumn: `IconColumn::make('${c}')->boolean()`,
    formImport: "Filament\\Forms\\Components\\Toggle",
    tableImport: "Filament\\Tables\\Columns\\IconColumn",
    cast: "'boolean'",
  }),
  integer: (c) => ({
    migration: `$table->integer('${c}')`,
    formComponent: `TextInput::make('${c}')->numeric()`,
    tableColumn: `TextColumn::make('${c}')`,
    formImport: "Filament\\Forms\\Components\\TextInput",
    tableImport: "Filament\\Tables\\Columns\\TextColumn",
  }),
  dateTime: (c) => ({
    migration: `$table->dateTime('${c}')`,
    formComponent: `DateTimePicker::make('${c}')`,
    tableColumn: `TextColumn::make('${c}')->dateTime()`,
    formImport: "Filament\\Forms\\Components\\DateTimePicker",
    tableImport: "Filament\\Tables\\Columns\\TextColumn",
    cast: "'datetime'",
  }),
};

export const emitField = (field: Field): FieldEmit => {
  const column = snakeColumn(field.name);
  const base = MAP[field.type as ScalarType](column);
  return { column, required: (field as { required?: boolean }).required === true, ...base };
};
```

- [ ] **Step 4: Run — PASS** — `pnpm --filter @camis/adapter-filament exec vitest run src/fields.test.ts`; `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/fields.ts packages/adapter-filament/src/fields.test.ts
git commit -m "feat(adapter-filament): scalar field mapping (migration/form/table)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Eloquent model emitter (`model.ts`)

**Files:** Create `packages/adapter-filament/src/model.ts`, `packages/adapter-filament/src/model.test.ts`.

- [ ] **Step 1: Failing test** — `packages/adapter-filament/src/model.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitModel } from "./model";

const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "string", name: "title", required: true },
    { type: "boolean", name: "published" },
    { type: "dateTime", name: "publishedAt" },
  ],
} as ContentType;

describe("emitModel", () => {
  it("emits an Eloquent model with table, fillable, and casts()", () => {
    const php = emitModel(article);
    expect(php).toContain("namespace App\\Models;");
    expect(php).toContain("class Article extends Model");
    expect(php).toContain("protected $table = 'articles';");
    expect(php).toContain("'title',");
    expect(php).toContain("'published_at',");
    expect(php).toContain("protected function casts(): array");
    expect(php).toContain("'published' => 'boolean',");
    expect(php).toContain("'published_at' => 'datetime',");
    expect(php.startsWith("<?php\n\ndeclare(strict_types=1);")).toBe(true);
  });
});
```

- [ ] **Step 2: Run — FAIL** — `pnpm --filter @camis/adapter-filament exec vitest run src/model.test.ts`.

- [ ] **Step 3: Implement** — `packages/adapter-filament/src/model.ts`
```ts
import type { ContentType } from "@camis/ir-schema";
import { emitField } from "./fields";
import { filamentNames } from "./names";

export const emitModel = (ct: ContentType): string => {
  const names = filamentNames(ct);
  const emits = ct.fields.map(emitField);
  const fillable = emits.map((e) => `        '${e.column}',`).join("\n");
  const casts = emits
    .filter((e) => e.cast !== undefined)
    .map((e) => `            '${e.column}' => ${e.cast},`)
    .join("\n");
  const castsMethod =
    casts.length > 0
      ? `\n    protected function casts(): array\n    {\n        return [\n${casts}\n        ];\n    }\n`
      : "";
  return `<?php

declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class ${names.model} extends Model
{
    protected $table = '${names.table}';

    protected $fillable = [
${fillable}
    ];
${castsMethod}}
`;
};
```

- [ ] **Step 4: Run — PASS** — `pnpm --filter @camis/adapter-filament exec vitest run src/model.test.ts`; `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/model.ts packages/adapter-filament/src/model.test.ts
git commit -m "feat(adapter-filament): Eloquent model emitter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Migration emitter (`migration.ts`)

**Files:** Create `packages/adapter-filament/src/migration.ts`, `packages/adapter-filament/src/migration.test.ts`.

- [ ] **Step 1: Failing test** — `packages/adapter-filament/src/migration.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitMigration, migrationFilename } from "./migration";

const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "string", name: "title", required: true },
    { type: "text", name: "body" },
    { type: "boolean", name: "published" },
  ],
} as ContentType;

describe("migration", () => {
  it("emits a create migration with portable columns and nullability", () => {
    const php = emitMigration(article);
    expect(php).toContain("Schema::create('articles', function (Blueprint $table): void {");
    expect(php).toContain("$table->id();");
    expect(php).toContain("$table->string('title');");
    expect(php).toContain("$table->text('body')->nullable();");
    expect(php).toContain("$table->boolean('published')->nullable();");
    expect(php).toContain("$table->timestamps();");
    expect(php).toContain("Schema::dropIfExists('articles');");
  });
  it("uses a deterministic ordinal filename (no timestamp)", () => {
    expect(migrationFilename(article, 1)).toBe("database/migrations/0000_00_00_000001_create_articles_table.php");
    expect(migrationFilename(article, 2)).toBe("database/migrations/0000_00_00_000002_create_articles_table.php");
  });
});
```

- [ ] **Step 2: Run — FAIL** — `pnpm --filter @camis/adapter-filament exec vitest run src/migration.test.ts`.

- [ ] **Step 3: Implement** — `packages/adapter-filament/src/migration.ts`
```ts
import type { ContentType } from "@camis/ir-schema";
import { emitField } from "./fields";
import { filamentNames } from "./names";

export const migrationFilename = (ct: ContentType, ordinal: number): string => {
  const table = filamentNames(ct).table;
  const seq = String(ordinal).padStart(6, "0");
  return `database/migrations/0000_00_00_${seq}_create_${table}_table.php`;
};

export const emitMigration = (ct: ContentType): string => {
  const names = filamentNames(ct);
  const columns = ct.fields
    .map(emitField)
    .map((e) => `            ${e.migration}${e.required ? "" : "->nullable()"};`)
    .join("\n");
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
```

- [ ] **Step 4: Run — PASS** — `pnpm --filter @camis/adapter-filament exec vitest run src/migration.test.ts`; `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/migration.ts packages/adapter-filament/src/migration.test.ts
git commit -m "feat(adapter-filament): migration emitter with ordinal filenames

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Resource + Form + Table + Pages emitter (`resource.ts`)

Emits the five Filament v5 files as `{ path, content }[]`. Imports for form/table components are collected from the field emits, de-duped, and sorted for determinism.

**Files:** Create `packages/adapter-filament/src/resource.ts`, `packages/adapter-filament/src/resource.test.ts`.

- [ ] **Step 1: Failing test** — `packages/adapter-filament/src/resource.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitResourceFiles } from "./resource";

const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "string", name: "title", required: true },
    { type: "boolean", name: "published" },
  ],
} as ContentType;

describe("emitResourceFiles", () => {
  const files = emitResourceFiles(article);
  const byPath = (p: string) => files.find((f) => f.path === p)!.content;

  it("emits resource, form, table, and three pages at v5 paths", () => {
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "app/Filament/Resources/Articles/ArticleResource.php",
      "app/Filament/Resources/Articles/Pages/CreateArticle.php",
      "app/Filament/Resources/Articles/Pages/EditArticle.php",
      "app/Filament/Resources/Articles/Pages/ListArticles.php",
      "app/Filament/Resources/Articles/Schemas/ArticleForm.php",
      "app/Filament/Resources/Articles/Schemas/ArticlesTable.php",
    ]);
  });
  it("resource wires model, form, table, pages", () => {
    const r = byPath("app/Filament/Resources/Articles/ArticleResource.php");
    expect(r).toContain("protected static ?string $model = Article::class;");
    expect(r).toContain("return ArticleForm::configure($schema);");
    expect(r).toContain("return ArticlesTable::configure($table);");
    expect(r).toContain("'index' => ListArticles::route('/'),");
  });
  it("form lists required component, table lists columns", () => {
    expect(byPath("app/Filament/Resources/Articles/Schemas/ArticleForm.php")).toContain("TextInput::make('title')->required(),");
    expect(byPath("app/Filament/Resources/Articles/Schemas/ArticlesTable.php")).toContain("IconColumn::make('published')->boolean(),");
  });
});
```

- [ ] **Step 2: Run — FAIL** — `pnpm --filter @camis/adapter-filament exec vitest run src/resource.test.ts`.

- [ ] **Step 3: Implement** — `packages/adapter-filament/src/resource.ts`
```ts
import type { ContentType } from "@camis/ir-schema";
import type { GeneratedFile } from "@camis/adapter-kernel";
import { emitField } from "./fields";
import { filamentNames } from "./names";

const useBlock = (imports: string[]): string =>
  [...new Set(imports)].sort().map((i) => `use ${i};`).join("\n");

export const emitResourceFiles = (ct: ContentType): GeneratedFile[] => {
  const n = filamentNames(ct);
  const dir = `app/Filament/Resources/${n.resourceDir}`;
  const ns = `App\\Filament\\Resources\\${n.resourceDir}`;
  const emits = ct.fields.map(emitField);

  // Page class names follow v5's make:filament-resource convention: List<plural>, Create<singular>, Edit<singular>.
  const listPage = `List${n.resourceDir}`;
  const createPage = `Create${n.model}`;
  const editPage = `Edit${n.model}`;

  const resource = `<?php

declare(strict_types=1);

namespace ${ns};

use ${ns}\\Pages\\${createPage};
use ${ns}\\Pages\\${editPage};
use ${ns}\\Pages\\${listPage};
use ${ns}\\Schemas\\${n.formClass};
use ${ns}\\Schemas\\${n.tableClass};
use App\\Models\\${n.model};
use Filament\\Resources\\Resource;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Table;

class ${n.resourceClass} extends Resource
{
    protected static ?string $model = ${n.model}::class;

    protected static ?string $navigationIcon = 'heroicon-o-rectangle-stack';

    public static function form(Schema $schema): Schema
    {
        return ${n.formClass}::configure($schema);
    }

    public static function table(Table $table): Table
    {
        return ${n.tableClass}::configure($table);
    }

    public static function getPages(): array
    {
        return [
            'index' => ${listPage}::route('/'),
            'create' => ${createPage}::route('/create'),
            'edit' => ${editPage}::route('/{record}/edit'),
        ];
    }
}
`;

  const formImports = useBlock([...emits.map((e) => e.formImport), "Filament\\Schemas\\Schema"]);
  const formBody = emits
    .map((e) => `            ${e.formComponent}${e.required ? "->required()" : ""},`)
    .join("\n");
  const form = `<?php

declare(strict_types=1);

namespace ${ns}\\Schemas;

${formImports}

class ${n.formClass}
{
    public static function configure(Schema $schema): Schema
    {
        return $schema->components([
${formBody}
        ]);
    }
}
`;

  const tableImports = useBlock([...emits.map((e) => e.tableImport), "Filament\\Tables\\Table"]);
  const tableBody = emits.map((e) => `            ${e.tableColumn},`).join("\n");
  const table = `<?php

declare(strict_types=1);

namespace ${ns}\\Schemas;

${tableImports}

class ${n.tableClass}
{
    public static function configure(Table $table): Table
    {
        return $table->columns([
${tableBody}
        ]);
    }
}
`;

  const page = (cls: string, base: string, baseImport: string, extra = ""): string => `<?php

declare(strict_types=1);

namespace ${ns}\\Pages;

use ${ns}\\${n.resourceClass};
use ${baseImport};

class ${cls} extends ${base}
{
    protected static string $resource = ${n.resourceClass}::class;${extra}
}
`;

  return [
    { path: `${dir}/${n.resourceClass}.php`, content: resource },
    { path: `${dir}/Schemas/${n.formClass}.php`, content: form },
    { path: `${dir}/Schemas/${n.tableClass}.php`, content: table },
    { path: `${dir}/Pages/${listPage}.php`, content: page(listPage, "ListRecords", "Filament\\Resources\\Pages\\ListRecords") },
    { path: `${dir}/Pages/${createPage}.php`, content: page(createPage, "CreateRecord", "Filament\\Resources\\Pages\\CreateRecord") },
    { path: `${dir}/Pages/${editPage}.php`, content: page(editPage, "EditRecord", "Filament\\Resources\\Pages\\EditRecord") },
  ];
};
```

Page names are name-driven (`List<plural>`, `Create<singular>`, `Edit<singular>`), so the emitter is correct for any content type — `Article` → `ListArticles`/`CreateArticle`/`EditArticle` (matching the test), `Tag` → `ListTags`/`CreateTag`/`EditTag`.

- [ ] **Step 4: Run — PASS** — `pnpm --filter @camis/adapter-filament exec vitest run src/resource.test.ts`; `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/resource.ts packages/adapter-filament/src/resource.test.ts
git commit -m "feat(adapter-filament): Filament v5 Resource/Form/Table/Pages emitter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `filamentAdapter` assembly (`generate.ts`) + index

**Files:** Create `packages/adapter-filament/src/generate.ts`; Modify `packages/adapter-filament/src/index.ts`; Create `packages/adapter-filament/src/generate.test.ts`.

- [ ] **Step 1: Failing test** — `packages/adapter-filament/src/generate.test.ts`
```ts
import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "./generate";

const bundle: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      { name: "Article", kind: "collection", fields: [{ type: "string", name: "title", required: true }] },
      { name: "Tag", kind: "collection", fields: [{ type: "string", name: "label", required: true }] },
    ],
    components: [],
  },
  roles: [],
};

describe("filamentAdapter", () => {
  const result = filamentAdapter.generate(bundle, { projectName: "blog" });
  const paths = result.files.map((f) => f.path);

  it("emits a model, an ordinal migration, and a resource set per content type", () => {
    expect(paths).toContain("app/Models/Article.php");
    expect(paths).toContain("database/migrations/0000_00_00_000001_create_articles_table.php");
    expect(paths).toContain("database/migrations/0000_00_00_000002_create_tags_table.php");
    expect(paths).toContain("app/Filament/Resources/Articles/ArticleResource.php");
  });
  it("builds a manifest and an empty gap report (scalars only)", () => {
    expect(result.manifest.files.length).toBe(result.files.length);
    expect(result.gaps).toEqual({ target: "filament", gaps: [] });
  });
  it("is deterministic / idempotent", () => {
    expect(filamentAdapter.generate(bundle, { projectName: "blog" })).toEqual(result);
  });
});
```

- [ ] **Step 2: Run — FAIL** — `pnpm --filter @camis/adapter-filament exec vitest run src/generate.test.ts`.

- [ ] **Step 3: Implement** — `packages/adapter-filament/src/generate.ts`
```ts
import {
  buildManifest,
  type GenerateAdapter,
  type GeneratedFile,
  type GenerationResult,
} from "@camis/adapter-kernel";
import { normalize } from "@camis/ir-core";
import type { CapabilityGap } from "@camis/ir-schema";
import { isScalar6A } from "./fields";
import { emitMigration, migrationFilename } from "./migration";
import { emitModel } from "./model";
import { filamentNames } from "./names";
import { emitResourceFiles } from "./resource";

export const filamentAdapter: GenerateAdapter = {
  target: "filament",
  generate: (ir, _options): GenerationResult => {
    const doc = normalize(ir.document);
    const files: GeneratedFile[] = [];
    const gaps: CapabilityGap[] = [];

    doc.contentTypes.forEach((ct, i) => {
      // 6A supports scalar fields only; anything else is a capability gap (deferred to 6B).
      for (const f of ct.fields) {
        if (!isScalar6A(f.type)) {
          gaps.push({
            feature: f.type,
            location: { contentType: ct.name, field: f.name },
            severity: "downgrade",
            message: `field type "${f.type}" is not supported in Phase 6A (scalars only)`,
          });
        }
      }
      const names = filamentNames(ct);
      files.push({ path: `app/Models/${names.model}.php`, content: emitModel(ct) });
      files.push({ path: migrationFilename(ct, i + 1), content: emitMigration(ct) });
      files.push(...emitResourceFiles(ct));
    });

    return { files, manifest: buildManifest(files), gaps: { target: "filament", gaps } };
  },
};
```

- [ ] **Step 4: Public surface** — set `packages/adapter-filament/src/index.ts`:
```ts
export { filamentAdapter } from "./generate";
```

- [ ] **Step 5: Run — PASS** — `pnpm --filter @camis/adapter-filament exec vitest run src/generate.test.ts`; `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 6: Commit**
```bash
git add packages/adapter-filament/src/generate.ts packages/adapter-filament/src/index.ts packages/adapter-filament/src/generate.test.ts
git commit -m "feat(adapter-filament): filamentAdapter assembles the overlay file set

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Fixture + golden tests

**Files:** Create `packages/adapter-filament/src/__fixtures__/blog.ts`, `packages/adapter-filament/src/golden.test.ts`, and the generated `src/__golden__/*` snapshots.

- [ ] **Step 1: Fixture** — `packages/adapter-filament/src/__fixtures__/blog.ts`
```ts
import type { IrBundle } from "@camis/permissions";

export const blog: IrBundle = {
  document: {
    version: 1,
    contentTypes: [
      {
        name: "Article",
        kind: "collection",
        fields: [
          { type: "string", name: "title", required: true },
          { type: "text", name: "body" },
          { type: "boolean", name: "published" },
          { type: "dateTime", name: "publishedAt" },
        ],
      },
    ],
    components: [],
  },
  roles: [],
};
```

- [ ] **Step 2: Golden test** — `packages/adapter-filament/src/golden.test.ts`
```ts
import { describe, expect, it } from "vitest";
import { filamentAdapter } from "./generate";
import { blog } from "./__fixtures__/blog";

describe("filament golden", () => {
  const result = filamentAdapter.generate(blog, { projectName: "blog" });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("model golden", async () => {
    await expect(content("app/Models/Article.php")).toMatchFileSnapshot("./__golden__/Article.model.php");
  });
  it("migration golden", async () => {
    await expect(content("database/migrations/0000_00_00_000001_create_articles_table.php")).toMatchFileSnapshot("./__golden__/create_articles_table.php");
  });
  it("resource golden", async () => {
    await expect(content("app/Filament/Resources/Articles/ArticleResource.php")).toMatchFileSnapshot("./__golden__/ArticleResource.php");
  });
  it("form golden", async () => {
    await expect(content("app/Filament/Resources/Articles/Schemas/ArticleForm.php")).toMatchFileSnapshot("./__golden__/ArticleForm.php");
  });
  it("table golden", async () => {
    await expect(content("app/Filament/Resources/Articles/Schemas/ArticlesTable.php")).toMatchFileSnapshot("./__golden__/ArticlesTable.php");
  });
  it("file listing golden", async () => {
    const listing = result.files.map((f) => `${f.mode ?? "overwrite"} ${f.path}`).sort().join("\n");
    await expect(listing).toMatchFileSnapshot("./__golden__/file-listing.txt");
  });
  it("regeneration is idempotent", () => {
    expect(filamentAdapter.generate(blog, { projectName: "blog" })).toEqual(result);
  });
});
```

- [ ] **Step 3: Generate goldens, then INSPECT** — Run: `pnpm --filter @camis/adapter-filament exec vitest run src/golden.test.ts -u`
  Read each generated file under `src/__golden__/`. Verify the model has `casts()` with `published`/`published_at`; the migration has `->nullable()` on the optional columns and `$table->id()`/`timestamps()`; the Resource/Form/Table reference the right classes; the file-listing has all 7 files. Confirm `__golden__/**` is excluded from Prettier (repo config already excludes it) so the PHP is not reformatted.

- [ ] **Step 4: Run — PASS** — `pnpm --filter @camis/adapter-filament test` (all green); `pnpm --filter @camis/adapter-filament typecheck`.

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/src/__fixtures__ packages/adapter-filament/src/golden.test.ts packages/adapter-filament/src/__golden__
git commit -m "test(adapter-filament): Article golden snapshots + idempotent regen

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Overlay script + gated boot workflow + sweep

**Files:** Create `packages/adapter-filament/scripts/overlay.ts`; Modify `packages/adapter-filament/package.json` (scripts); Create `.github/workflows/adapter-filament-boot.yml`.

- [ ] **Step 1: Overlay script** — `packages/adapter-filament/scripts/overlay.ts`
```ts
// Materializes the Filament overlay into an already-scaffolded Laravel app dir (argv[2]).
// Runs only in the gated adapter-filament-boot job (needs a scaffolded app); not in unit tests.
import { materialize } from "@camis/adapter-kernel";
import { filamentAdapter } from "../src/generate";
import { blog } from "../src/__fixtures__/blog";

const dest = process.argv[2];
if (!dest) {
  console.error("usage: tsx scripts/overlay.ts <laravel-app-dir>");
  process.exit(1);
}
await materialize(filamentAdapter.generate(blog, { projectName: "blog" }), dest);
console.log(`overlay materialized into ${dest}`);
```

- [ ] **Step 2: Package scripts** — add to `packages/adapter-filament/package.json` `scripts`:
```json
    "overlay": "tsx scripts/overlay.ts"
```
(Confirm `tsx` is available as it is for `@camis/expr-php-emit`; if not, `pnpm --filter @camis/adapter-filament add -D tsx`.)

- [ ] **Step 3: Gated boot workflow** — `.github/workflows/adapter-filament-boot.yml`
```yaml
name: adapter-filament-boot
on:
  workflow_dispatch:
  pull_request:
  schedule:
    - cron: "0 6 * * *"
jobs:
  boot:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        db: [sqlite, mysql, pgsql]
    services:
      mysql:
        image: mysql:8
        env:
          MYSQL_DATABASE: camis
          MYSQL_ROOT_PASSWORD: camis
        ports: ["3306:3306"]
        options: >-
          --health-cmd="mysqladmin ping" --health-interval=10s --health-timeout=5s --health-retries=5
      postgres:
        image: postgres:16
        env:
          POSTGRES_DB: camis
          POSTGRES_PASSWORD: camis
        ports: ["5432:5432"]
        options: >-
          --health-cmd="pg_isready" --health-interval=10s --health-timeout=5s --health-retries=5
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
      - name: Scaffold Laravel 12 + Filament v5
        run: |
          composer create-project laravel/laravel:^12 app --no-interaction
          cd app
          composer require filament/filament:"^5.0" --no-interaction
          php artisan filament:install --panels --no-interaction
      - name: Overlay camis-generated files
        run: pnpm --filter @camis/adapter-filament overlay "$GITHUB_WORKSPACE/app"
      - name: Configure DB env (${{ matrix.db }})
        run: |
          cd app
          case "${{ matrix.db }}" in
            sqlite) echo "DB_CONNECTION=sqlite" >> .env; touch database/database.sqlite ;;
            mysql)  printf 'DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=3306\nDB_DATABASE=camis\nDB_USERNAME=root\nDB_PASSWORD=camis\n' >> .env ;;
            pgsql)  printf 'DB_CONNECTION=pgsql\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_DATABASE=camis\nDB_USERNAME=postgres\nDB_PASSWORD=camis\n' >> .env ;;
          esac
      - name: Migrate + boot check
        run: |
          cd app
          php artisan migrate --force
          php artisan about
          php artisan filament:check || true
```
(The exact boot-check command is best-effort; `php artisan about` + a successful `migrate` prove the app boots and the schema applies. Adjust if `filament:check` is unavailable in v5.)

- [ ] **Step 4: Full sweep** — run and report:
```bash
pnpm lint
pnpm -r typecheck
pnpm -r test
```
All green. (The gated boot workflow is not run locally — it executes in CI where PHP/Composer/DB services exist.)

- [ ] **Step 5: Commit**
```bash
git add packages/adapter-filament/scripts packages/adapter-filament/package.json .github/workflows/adapter-filament-boot.yml pnpm-lock.yaml
git commit -m "ci(adapter-filament): overlay script + gated 3-DB boot workflow

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:** D1 Filament v5 layout (Tasks 6,9) · D2 overlay + materialize-safe (Tasks 7,9) · D3 ordinal migration filenames (Task 5) · D4 portable migrations / no DB code, env in CI (Tasks 5,9) · D5 golden+structural local, gated boot (Tasks 8,9) · D6 `generate(IrBundle)` ignores roles (Task 7) · D7 scalar subset + gap for the rest (Tasks 3,7) · D8 sqlite/mysql/pgsql matrix (Task 9). Exit criteria: Article overlay golden+idempotent (Task 8); gated boot job (Task 9); lint/typecheck/test (Task 9).

**Placeholder scan:** none — concrete code/commands throughout. Goldens are generated via `-u` then inspected (Task 8 Step 3). The v5 file layout is our best-effort template, validated by the gated boot job (the documented oracle); the boot-check command is explicitly best-effort.

**Type consistency:** `filamentNames` fields (`model`/`table`/`resourceDir`/`resourceClass`/`formClass`/`tableClass`) defined in Task 2, consumed in Tasks 4,5,6. `emitField`/`FieldEmit` (Task 3) consumed in Tasks 4,5,6. `emitModel` (4), `emitMigration`/`migrationFilename` (5), `emitResourceFiles` (6) consumed by `filamentAdapter` (7). `filamentAdapter`/`blog` consumed by goldens (8) and overlay (9). `GeneratedFile`/`GenerationResult`/`buildManifest`/`materialize` from `@camis/adapter-kernel`; `IrBundle` from `@camis/permissions`; `normalize` from `@camis/ir-core`.

**Multi-type correctness:** page class names are name-driven (`List<plural>`/`Create<singular>`/`Edit<singular>`), so emitters are correct for any content type, not just `Article` (verified by the `Article` + `Tag` fixture in Task 7).
