import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContentType } from "@camis/ir-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHP_MARKER } from "../hooks/names";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { emitHasLocale, emitStrapiLocales } from "./i18n-runtime";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const result = filamentAdapter.generate(strapiApiBundle, {
  projectName: "oyl",
  apiStyle: "strapi",
});
const content = (p: string): string => {
  const f = result.files.find((x) => x.path === p || x.path.endsWith(p));
  if (!f) throw new Error(`not generated: ${p}`);
  return f.content;
};

const runtimes = [
  { path: "app/Support/StrapiLocales.php", namespace: "App\\Support", emit: emitStrapiLocales },
  {
    path: "app/Models/Concerns/HasLocale.php",
    namespace: "App\\Models\\Concerns",
    emit: emitHasLocale,
  },
];

describe("i18n runtime files", () => {
  it.each(runtimes)("$path is generated, marked, strict and namespaced", ({ path, namespace }) => {
    const php = content(path);
    expect(php.startsWith(`<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n`)).toBe(true);
    expect(php).toContain(`namespace ${namespace};`);
  });
  it("StrapiLocales golden", async () => {
    await expect(emitStrapiLocales()).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiLocales.php",
    );
  });
  it("HasLocale golden", async () => {
    await expect(emitHasLocale()).toMatchFileSnapshot("./__golden__/strapi-api/HasLocale.php");
  });
  describe.skipIf(!hasPhp())("php -l", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "camis-i18n-"));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    it.each([
      ...runtimes,
      { path: "app/Models/Locale.php", emit: () => content("app/Models/Locale.php") },
      {
        path: "LocaleController.php",
        emit: () => content("app/Http/Controllers/Api/LocaleController.php"),
      },
      { path: "locales migration", emit: () => content("_create_i18n_locales_table.php") },
    ])("$path parses", ({ emit }) => {
      const file = join(dir, "f.php");
      writeFileSync(file, emit());
      expect(execFileSync("php", ["-l", file], { encoding: "utf8" })).toContain("No syntax errors");
    });
  });
});

describe("locales", () => {
  it("are kept in a table whose migration adds the default locale", () => {
    const migration = content("_create_i18n_locales_table.php");
    expect(migration).toContain("Schema::create('i18n_locales'");
    expect(migration).toContain("config('camis.i18n.default_locale', 'en')");
    expect(content("app/Models/Locale.php")).toContain("protected $table = 'i18n_locales';");
  });
  it("are listed at Strapi's route", () => {
    expect(content("routes/api.php")).toContain(
      "Route::get('i18n/locales', [LocaleController::class, 'index']);",
    );
  });
  it("are managed in the admin", () => {
    expect(content("app/Filament/Resources/Locales/LocaleResource.php")).toContain(
      "protected static ?string $model = Locale::class;",
    );
  });
  it("name the default locale in config", () => {
    expect(content("config/camis.php")).toContain(
      "'default_locale' => env('CAMIS_DEFAULT_LOCALE', 'en'),",
    );
  });
});

describe("one row per document and locale", () => {
  it("lets every locale of a document share its documentId", () => {
    const articles = content("_create_articles_table.php");
    expect(articles).toContain("$table->string('document_id', 24)->index();");
    expect(articles).toContain("$table->string('locale', 16)->index();");
    expect(content("_create_books_table.php")).toContain(
      "$table->string('document_id', 24)->unique();",
    );
  });
  it("gives the model the locale trait and the columns every locale shares", () => {
    const article = content("app/Models/Article.php");
    expect(article).toContain("use HasLocale;");
    expect(article).toContain("public function sharedAcrossLocales(): array");
    expect(article).toContain("return ['code'];");
    expect(content("app/Models/Book.php")).not.toContain("HasLocale");
  });
  it("unlinks, rather than blocks, when a linked locale goes away", () => {
    expect(content("_create_books_table.php")).toContain(
      "$table->foreignId('category_id')->nullable()->constrained('categories')->nullOnDelete();",
    );
  });
});

describe("serializers of localized types", () => {
  const article = content("app/Http/Serializers/ArticleSerializer.php");
  it("send and filter by locale", () => {
    expect(article).toContain("'locale' => $m->locale,");
    expect(article).toContain("'locale' => ['column' => 'locale', 'type' => 'string'],");
    expect(article).toContain("public const LOCALIZED = true;");
    expect(content("app/Http/Serializers/BookSerializer.php")).toContain(
      "public const LOCALIZED = false;",
    );
  });
  it("populate the document's other locales as localizations", () => {
    expect(article).toMatch(
      /'localizations' => \['relation' => 'localizations', 'kind' => 'localizations',/,
    );
  });
  it("say whether each relation's target is localized", () => {
    expect(article).toMatch(/'category' => \[[^\n]*'localized' => true,/);
    expect(article).toMatch(/'genres' => \[[^\n]*'localized' => false,/);
  });
});

describe("controllers of localized types", () => {
  const article = content("app/Http/Controllers/Api/Generated/ArticleApiController.php");
  it("read the locale the parameter names, the default one otherwise", () => {
    expect(article).toContain(
      "return StrapiLocales::narrow(Article::query()->forUser($request->user()), $request->query());",
    );
  });
  it("create in the requested locale", () => {
    expect(article).toContain("$m->locale = StrapiLocales::forWrite($request->query());");
  });
  it("create a missing locale of an existing document on update", () => {
    expect(article).toContain(
      "?? StrapiLocales::localization(Article::query()->forUser($request->user())->where(self::KEY, $key), StrapiLocales::forWrite($request->query()));",
    );
  });
  it("link targets in the source's locale", () => {
    expect(article).toContain(
      "StrapiRelations::read((array) $request->input('data', []), ArticleSerializer::FIELDS, $request->user(), StrapiLocales::forWrite($request->query()));",
    );
  });
  it("delete the requested locale's rows", () => {
    expect(article).toContain("$rows = $this->documents($request)->where(self::KEY, $key)->get()");
  });
  it("leave types without locales as they are", () => {
    expect(content("app/Http/Controllers/Api/Generated/BookApiController.php")).not.toContain(
      "StrapiLocales",
    );
  });
});

describe("the Filament admin edits one locale at a time", () => {
  it("lists the default locale unless another is picked", () => {
    const table = content("app/Filament/Resources/Articles/Schemas/ArticlesTable.php");
    expect(table).toContain("TextColumn::make('locale')->badge()");
    expect(table).toContain(
      "SelectFilter::make('locale')->options(fn (): array => Locale::query()->pluck('name', 'code')->all())->default(StrapiLocales::default())",
    );
  });
  it("creates in a chosen locale", () => {
    expect(content("app/Filament/Resources/Articles/Schemas/ArticleForm.php")).toContain(
      "Select::make('locale')->options(fn (): array => Locale::query()->pluck('name', 'code')->all())->default(fn (): string => StrapiLocales::default())->required()->disabledOn('edit')",
    );
  });
  it("translates a document into a locale it lacks", () => {
    const edit = content("app/Filament/Resources/Articles/Pages/EditArticle.php");
    expect(edit).toContain("Action::make('translate')");
    expect(edit).toContain("$copy = $this->record->replicate();");
  });
  it("keeps publishing on a localized draft-and-publish type", () => {
    const edit = content("app/Filament/Resources/Pages/Pages/EditPage.php");
    expect(edit).toContain("Action::make('publish')");
    expect(edit).toContain("Action::make('translate')");
  });
  it("offers link targets in the record's locale, or the default one from a type without", () => {
    expect(content("app/Filament/Resources/Articles/Schemas/ArticleForm.php")).toContain(
      "Select::make('category_id')->relationship(name: 'category', titleAttribute: 'id', modifyQueryUsing: fn ($query, $get) => $query->where('locale', $get('locale')))",
    );
    expect(content("app/Filament/Resources/Books/Schemas/BookForm.php")).toContain(
      "modifyQueryUsing: fn ($query) => $query->where('locale', \\App\\Support\\StrapiLocales::default()))",
    );
  });
});

describe("localization capability gaps", () => {
  const gapsFor = (ct: ContentType, apiStyle: "strapi" | "laravel" = "strapi") =>
    filamentAdapter
      .generate(
        { roles: [], document: { version: 1, contentTypes: [ct], components: [] } },
        { projectName: "x", apiStyle },
      )
      .gaps.gaps.filter((g) => g.feature === "localized");
  const base: ContentType = {
    name: "Story",
    kind: "collection",
    options: { localized: true },
    fields: [{ type: "string", name: "slug" }],
  };
  it("reports that the Laravel API style keeps one row per record", () => {
    expect(gapsFor(base, "laravel")).toHaveLength(1);
    expect(gapsFor(base)).toHaveLength(0);
  });
  it("drops localization where upsertBy makes the key unique per row", () => {
    const upsert = { ...base, options: { localized: true, upsertBy: "slug" } };
    expect(gapsFor(upsert)[0]?.message).toContain("upsertBy");
  });
  it("reports that a unique field is not enforced across a document's locales", () => {
    const unique: ContentType = {
      ...base,
      fields: [{ type: "string", name: "slug", unique: true }],
    };
    expect(gapsFor(unique)[0]?.location).toEqual({ contentType: "Story", field: "slug" });
  });
  it("reports a relation marked as shared, which stays per locale", () => {
    const shared: ContentType = {
      ...base,
      fields: [
        {
          type: "relation",
          name: "parent",
          relationKind: "manyToOne",
          target: "Story",
          localized: false,
        },
      ],
    };
    expect(gapsFor(shared)[0]?.location).toEqual({ contentType: "Story", field: "parent" });
  });
});

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");

describe("i18n conformance vectors", () => {
  it("every step has a unique name and a recorded strapi-php outcome", () => {
    const vectors = JSON.parse(fixture("i18n-vectors.json")) as { writes: { name: string }[] };
    const expected = JSON.parse(fixture("i18n-vectors.expected.json")) as object;
    const names = vectors.writes.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(expected).sort()).toEqual([...names].sort());
  });
});
