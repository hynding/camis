import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHP_MARKER } from "../hooks/names";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import {
  emitHasLinkOrder,
  emitStrapiLinkOrder,
  emitStrapiLinkPivot,
  emitStrapiRelationsOrderer,
} from "./link-order";
import { emitStrapiPopulate, emitStrapiRelations } from "./populate-runtime";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const generate = (options: { alwaysPopulateComponents?: boolean } = {}) =>
  filamentAdapter.generate(strapiApiBundle, { projectName: "oyl", apiStyle: "strapi", ...options });
const result = generate();
const content = (p: string, r = result): string => {
  const f = r.files.find((x) => x.path === p);
  if (!f) throw new Error(`not generated: ${p}`);
  return f.content;
};
const serializer = (model: string): string =>
  content(`app/Http/Serializers/${model}Serializer.php`);
const controller = (model: string): string =>
  content(`app/Http/Controllers/Api/Generated/${model}ApiController.php`);

const runtimes = [
  { path: "app/Support/StrapiPopulate.php", emit: emitStrapiPopulate },
  { path: "app/Support/StrapiRelations.php", emit: emitStrapiRelations },
  { path: "app/Support/StrapiLinkOrder.php", emit: emitStrapiLinkOrder },
  { path: "app/Support/StrapiRelationsOrderer.php", emit: emitStrapiRelationsOrderer },
  { path: "app/Support/StrapiLinkPivot.php", emit: emitStrapiLinkPivot },
];

describe("populate and relation runtime files", () => {
  it.each(runtimes)("$path is generated, marked, strict and namespaced", ({ path }) => {
    const php = content(path);
    expect(php.startsWith(`<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n`)).toBe(true);
    expect(php).toContain("namespace App\\Support;");
  });
  it("StrapiPopulate golden", async () => {
    await expect(emitStrapiPopulate()).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiPopulate.php",
    );
  });
  it("StrapiRelations golden", async () => {
    await expect(emitStrapiRelations()).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiRelations.php",
    );
  });
  it("StrapiLinkOrder and StrapiRelationsOrderer golden", async () => {
    await expect(emitStrapiLinkOrder()).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiLinkOrder.php",
    );
    await expect(emitStrapiRelationsOrderer()).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiRelationsOrderer.php",
    );
  });
  it("StrapiLinkPivot and HasLinkOrder golden", async () => {
    await expect(emitStrapiLinkPivot()).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiLinkPivot.php",
    );
    await expect(emitHasLinkOrder()).toMatchFileSnapshot(
      "./__golden__/strapi-api/HasLinkOrder.php",
    );
  });

  describe.skipIf(!hasPhp())("php -l", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "camis-populate-runtime-"));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    it.each(runtimes)("$path parses", ({ emit }) => {
      const file = join(dir, "f.php");
      writeFileSync(file, emit());
      expect(execFileSync("php", ["-l", file], { encoding: "utf8" })).toContain("No syntax errors");
    });
  });
});

describe("serializer relation and component maps", () => {
  it("lists the top-level components populate can name", () => {
    expect(serializer("Book")).toContain("public const COMPONENTS = ['price', 'editions'];");
    expect(serializer("Tag")).toContain("public const COMPONENTS = [];");
  });
  it("marks a repeatable component as a component, not a relation", () => {
    expect(serializer("Book")).toContain("'editions' => ['component' => 'editions', 'fields' => [");
  });
  it("maps a to-one relation to its target serializer, model, foreign key and Strapi uid", () => {
    expect(serializer("Book")).toContain(
      "'author' => ['relation' => 'author', 'kind' => 'belongsTo', 'model' => \\App\\Models\\Author::class, 'serializer' => AuthorSerializer::class, 'foreignKey' => 'author_id', 'uid' => 'api::author.author', 'holder' => 'self', 'draftPublish' => false, 'localized' => false, 'order' => null, 'inverseOrder' => 'author_ord'],",
    );
  });
  it("maps a to-many relation through its pivot, which keeps both sides' link order", () => {
    expect(serializer("Book")).toContain(
      "'genres' => ['relation' => 'genres', 'kind' => 'belongsToMany', 'model' => \\App\\Models\\Genre::class, 'serializer' => GenreSerializer::class, 'foreignKey' => null, 'uid' => 'api::genre.genre', 'holder' => 'self', 'draftPublish' => false, 'localized' => false, 'order' => 'genre_ord', 'inverseOrder' => 'book_ord'],",
    );
  });
  it("maps the inverse side of a relation, whose foreign key and link order live on the other table", () => {
    expect(serializer("Author")).toContain(
      "'books' => ['relation' => 'books', 'kind' => 'hasMany', 'model' => \\App\\Models\\Book::class, 'serializer' => BookSerializer::class, 'foreignKey' => 'author_id', 'uid' => 'api::book.book', 'holder' => 'target', 'draftPublish' => false, 'localized' => false, 'order' => 'author_ord', 'inverseOrder' => null],",
    );
  });
  it("maps a relation to the users-permissions user to its serializer and Strapi uid", () => {
    expect(serializer("Review")).toContain(
      "'reviewer' => ['relation' => 'reviewer', 'kind' => 'belongsTo', 'model' => \\App\\Models\\User::class, 'serializer' => UserSerializer::class, 'foreignKey' => 'reviewer_id', 'uid' => 'plugin::users-permissions.user', 'holder' => 'self', 'draftPublish' => false, 'localized' => false, 'order' => null, 'inverseOrder' => null],",
    );
    expect(serializer("Review")).toContain(
      "'readers' => ['relation' => 'readers', 'kind' => 'belongsToMany', 'model' => \\App\\Models\\User::class, 'serializer' => UserSerializer::class, 'foreignKey' => null, 'uid' => 'plugin::users-permissions.user', 'holder' => 'self', 'draftPublish' => false, 'localized' => false, 'order' => 'user_ord', 'inverseOrder' => 'review_ord'],",
    );
  });
  it("renders a populated user as users-permissions does, its role a relation no grant reaches", () => {
    const user = serializer("User");
    expect(user).toContain("public const FIELDS = StrapiUsers::FIELDS + [");
    expect(user).toContain(
      "'role' => ['relation' => 'roles', 'kind' => 'belongsToMany', 'model' => \\Spatie\\Permission\\Models\\Role::class,",
    );
    expect(user).toContain("return StrapiUsers::wire($m);");
  });
});

describe("link order", () => {
  const migration = (): string =>
    content("database/migrations/0001_01_03_000000_add_link_order_columns.php");
  it("keeps a many-to-many's order for both sides on its pivot, as Strapi's link table does", () => {
    expect(migration()).toContain(
      "        Schema::table('book_genre', function (Blueprint $table): void {\n            $table->double('book_ord')->nullable();\n            $table->double('genre_ord')->nullable();\n        });",
    );
  });
  it("keeps the order of a many-to-one's other side beside the foreign key", () => {
    expect(migration()).toContain(
      "        Schema::table('books', function (Blueprint $table): void {\n            $table->double('author_ord')->nullable();\n        });",
    );
  });
  it("adds none for a relation no side lists", () => {
    // Book.topic is a many-to-one Topic does not list.
    expect(migration()).not.toMatch(/Schema::table\('books'[^}]*topic_ord/);
    expect(migration()).not.toContain("Schema::table('notes'");
  });
  it("places a to-one link made outside the API at the end of the list it joins", () => {
    // Book.author is listed by Author.books; the admin's select and any save go through the model.
    const book = content("app/Models/Book.php");
    expect(book).toContain("    use HasLinkOrder;\n");
    expect(book).toContain("    public const LINK_ORDERS = ['author_id' => 'author_ord'];");
    expect(content("app/Models/Note.php")).not.toContain("HasLinkOrder");
    expect(content("app/Models/Concerns/HasLinkOrder.php")).toContain(
      "StrapiLinkOrder::next($row, $foreignKey, $order, $row->getAttribute($foreignKey))",
    );
  });
  it("places a pivot link made outside the API at the end of both sides' lists", () => {
    // The admin's multi-select syncs the pivot; each attached row is a StrapiLinkPivot.
    expect(content("app/Models/Book.php")).toContain(
      "return $this->belongsToMany(Genre::class, 'book_genre', 'book_id', 'genre_id')->using(\\App\\Support\\StrapiLinkPivot::class);",
    );
    expect(content("app/Support/StrapiLinkPivot.php")).toContain(
      "final class StrapiLinkPivot extends Pivot",
    );
  });
  it("writes connects through Strapi's relation orderer", () => {
    expect(content("app/Support/StrapiLinkOrder.php")).toContain(
      "public static function write(Model $row, Relation $eloquent, array $link): void",
    );
    expect(content("app/Support/StrapiRelationsOrderer.php")).toContain(
      "The relation with id %s needs to be connected first.",
    );
  });
});

describe("relations a grant assigns", () => {
  it("are not read from the body, so a caller cannot hand a row to another user", () => {
    expect(controller("Note")).toContain(
      "$links = StrapiRelations::read(array_diff_key((array) $request->input('data', []), ['owner' => true]), NoteSerializer::FIELDS, $request->user());",
    );
  });
});

describe("relation targets without a read scope", () => {
  it("are narrowed only when their model has one (the user model has none)", () => {
    expect(content("app/Support/StrapiQuery.php")).toContain(
      "if (! self::$unrestricted && $query->getModel()->hasNamedScope('forUser')) {",
    );
  });
});

describe("controllers render through populate and write relations", () => {
  const book = controller("Book");
  it("renders lists and single documents through StrapiPopulate with the caller", () => {
    expect(book).toContain(
      "'data' => StrapiPopulate::many($rows, $request->query(), BookSerializer::class, $request->user()),",
    );
    expect(book).toContain(
      "return StrapiPopulate::one($m, $request->query(), BookSerializer::class, $request->user());",
    );
  });
  it("resolves relation input before saving and links it inside the transaction", () => {
    expect(book).toContain(
      "$links = StrapiRelations::read((array) $request->input('data', []), BookSerializer::FIELDS, $request->user());",
    );
    expect(book).toContain("StrapiRelations::link($m, $links);");
  });
  it("lets list filters and sort reach relations as the caller", () => {
    expect(book).toContain(
      "StrapiQuery::find($this->scoped($request), $request->query(), BookSerializer::FIELDS, $request->user());",
    );
  });
  it("passes no caller when the project has no roles, so nothing is filtered by grants", () => {
    const open = filamentAdapter.generate(
      { ...strapiApiBundle, roles: [] },
      { projectName: "oyl", apiStyle: "strapi" },
    );
    expect(content("app/Http/Controllers/Api/Generated/BookApiController.php", open)).toContain(
      "StrapiPopulate::many($rows, $request->query(), BookSerializer::class, null)",
    );
  });
});

describe("always-populated components (a per-project option)", () => {
  it("is off by default, as on Strapi 5", () => {
    expect(content("config/camis.php")).toContain(
      "'always_populate_components' => (bool) env('CAMIS_REST_ALWAYS_POPULATE_COMPONENTS', false),",
    );
  });
  it("defaults on when the project asks for it", () => {
    expect(content("config/camis.php", generate({ alwaysPopulateComponents: true }))).toContain(
      "'always_populate_components' => (bool) env('CAMIS_REST_ALWAYS_POPULATE_COMPONENTS', true),",
    );
  });
});

interface Seed {
  path: string;
  as: string;
  data: Record<string, unknown>;
}
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");
const vectors = JSON.parse(fixture("populate-vectors.json")) as {
  seed: Seed[];
  reads: { name: string }[];
  writes: { name: string }[];
};

describe("populate conformance vectors", () => {
  it("seed rows only use fields their content type declares", () => {
    const byPath = new Map(
      strapiApiBundle.document.contentTypes.map((ct) => [
        `/${(ct.names?.plural ?? ct.name).toLowerCase()}`,
        new Set(ct.fields.map((f) => f.name)),
      ]),
    );
    for (const row of vectors.seed) {
      const names = byPath.get(row.path);
      expect(names, row.path).toBeDefined();
      for (const k of Object.keys(row.data)) expect(names).toContain(k);
    }
  });
  it.each(["populate-vectors", "user-relation-vectors", "link-order-vectors"])(
    "%s: every read and write has a unique name and a recorded strapi-php outcome",
    (file) => {
      const set = JSON.parse(fixture(`${file}.json`)) as typeof vectors;
      const recorded = JSON.parse(fixture(`${file}.expected.json`)) as Record<string, unknown>;
      const names = [...set.reads, ...set.writes].map((v) => v.name);
      expect(new Set(names).size).toBe(names.length);
      expect(Object.keys(recorded).sort()).toEqual([...names].sort());
    },
  );
});
