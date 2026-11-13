import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../../generate";
import { morphRelationsBundle } from "../__fixtures__/morph-relations";

const strapi = filamentAdapter.generate(morphRelationsBundle, {
  projectName: "notes",
  apiStyle: "strapi",
});
const file = (result: typeof strapi, path: string): string =>
  result.files.find((f) => f.path === path)?.content ?? "";
const migration = (result: typeof strapi, table: string): string =>
  result.files.find((f) => f.path.endsWith(`_create_${table}_table.php`))?.content ?? "";

describe("polymorphic relations on the Strapi API style", () => {
  it("keeps a to-many's links in a table of their own, each with its entry's type", () => {
    expect(migration(strapi, "notes")).not.toContain("'subjects'");
    const links = migration(strapi, "notes_subjects_mph");
    expect(links).toContain("Schema::create('notes_subjects_mph'");
    expect(links).toContain(
      "$table->foreignId('note_id')->constrained('notes')->cascadeOnDelete();",
    );
    expect(links).toContain("$table->unsignedBigInteger('subjects_id');");
    expect(links).toContain("$table->string('subjects_type');");
    expect(links).toContain("$table->string('field')->nullable();");
    expect(links).toContain("$table->float('order')->nullable();");
  });

  it("keeps a to-one's link in two columns of the entry's own row", () => {
    const notes = migration(strapi, "notes");
    expect(notes).toContain("$table->unsignedBigInteger('pinned_to_id')->nullable();");
    expect(notes).toContain("$table->string('pinned_to_type')->nullable();");
    expect(notes).not.toContain("$table->string('pinned_to')");
  });

  it("gives an inverse no column: it reads the target's link", () => {
    expect(migration(strapi, "books")).not.toMatch(/'pins'|'remarks'/);
    expect(migration(strapi, "films")).not.toContain("'pin'");
  });

  it("maps each owning side by its storage and each inverse as a relation read through the target's link", () => {
    const notes = file(strapi, "app/Http/Serializers/NoteSerializer.php");
    expect(notes).toContain(
      "'subjects' => ['morph' => 'morphToMany', 'table' => 'notes_subjects_mph', 'ownerColumn' => 'note_id', 'idColumn' => 'subjects_id', 'typeColumn' => 'subjects_type'],",
    );
    expect(notes).toContain(
      "'pinned_to' => ['morph' => 'morphToOne', 'idColumn' => 'pinned_to_id', 'typeColumn' => 'pinned_to_type'],",
    );
    // Strapi leaves a relation off the wire unless populate names it.
    expect(notes).not.toMatch(/'subjects' => \$m|'pinned_to' => \$m/);
    const books = file(strapi, "app/Http/Serializers/BookSerializer.php");
    expect(books).toContain(
      "'pins' => ['relation' => 'pins', 'kind' => 'hasMany', 'model' => \\App\\Models\\Note::class, 'serializer' => NoteSerializer::class, 'foreignKey' => 'pinned_to_id', 'uid' => 'api::note.note', 'holder' => 'target', 'draftPublish' => true, 'localized' => false, 'order' => null, 'inverseOrder' => null, 'readOnly' => true],",
    );
    expect(books).toContain(
      "'remarks' => ['relation' => 'remarks', 'kind' => 'belongsToMany', 'model' => \\App\\Models\\Note::class, 'serializer' => NoteSerializer::class, 'foreignKey' => null, 'uid' => 'api::note.note', 'holder' => 'target', 'draftPublish' => true, 'localized' => false, 'order' => null, 'inverseOrder' => null, 'readOnly' => true],",
    );
    expect(file(strapi, "app/Http/Serializers/FilmSerializer.php")).toContain(
      "'pin' => ['relation' => 'pin', 'kind' => 'hasOne',",
    );
  });

  it("reads an inverse through the target's link columns, or its link table by the link's field", () => {
    const book = file(strapi, "app/Models/Book.php");
    expect(book).toContain(
      "return $this->hasMany(\\App\\Models\\Note::class, 'pinned_to_id')->where('pinned_to_type', 'api::book.book');",
    );
    expect(book).toContain(
      "return $this->belongsToMany(\\App\\Models\\Note::class, 'notes_subjects_mph', 'subjects_id', 'note_id')->wherePivot('subjects_type', 'api::book.book')->wherePivot('field', 'remarks');",
    );
    expect(file(strapi, "app/Models/Film.php")).toContain(
      "return $this->hasOne(\\App\\Models\\Note::class, 'pinned_to_id')->where('pinned_to_type', 'api::film.film');",
    );
    expect(book).not.toMatch(/'pins',|'remarks',/);
  });

  it("names every type a link may hold by its Strapi uid", () => {
    const types = file(strapi, "app/Support/StrapiMorphTypes.php");
    expect(types).toContain(
      "'api::book.book' => [\\App\\Models\\Book::class, \\App\\Http\\Serializers\\BookSerializer::class],",
    );
    expect(types).toContain("'api::secret.secret' => [");
  });

  it("leaves them out of the admin, as Strapi's Content Manager does", () => {
    for (const path of [
      "app/Filament/Resources/Notes/Schemas/NoteForm.php",
      "app/Filament/Resources/Notes/Schemas/NotesTable.php",
      "app/Filament/Resources/Books/Schemas/BookForm.php",
      "app/Filament/Resources/Books/NoteResource.php",
    ]) {
      expect(file(strapi, path)).not.toMatch(/subjects|pinned_to|'pins'|'remarks'/);
    }
  });

  it("reports only that GraphQL leaves them out", () => {
    expect(strapi.gaps.gaps.filter((g) => /^polymorphic/.test(g.feature))).toEqual([]);
    const graphql = filamentAdapter.generate(morphRelationsBundle, {
      projectName: "notes",
      apiStyle: "strapi",
      graphql: true,
    });
    expect(graphql.gaps.gaps.filter((g) => g.feature === "polymorphicGraphql")).toEqual([
      {
        feature: "polymorphicGraphql",
        location: { contentType: "Note", field: "subjects" },
        severity: "downgrade",
        message: `polymorphic relation "subjects" is served over REST only; the GraphQL schema leaves it out.`,
      },
      expect.objectContaining({ location: { contentType: "Note", field: "pinnedTo" } }),
      expect.objectContaining({ location: { contentType: "Book", field: "pins" } }),
      expect.objectContaining({ location: { contentType: "Book", field: "remarks" } }),
      expect.objectContaining({ location: { contentType: "Film", field: "pin" } }),
    ]);
  });
});

describe("polymorphic relations elsewhere", () => {
  it("are reported on the Laravel API style, with nothing generated for them", () => {
    const laravel = filamentAdapter.generate(morphRelationsBundle, { projectName: "notes" });
    expect(laravel.gaps.gaps.filter((g) => /^polymorphic/.test(g.feature))).toEqual([
      {
        feature: "polymorphicRelation",
        location: { contentType: "Note", field: "subjects" },
        severity: "downgrade",
        message: `polymorphic relation "subjects" is served on the Strapi API style over Laravel storage only; skipped.`,
      },
      expect.objectContaining({ location: { contentType: "Note", field: "pinnedTo" } }),
      expect.objectContaining({ location: { contentType: "Book", field: "pins" } }),
      expect.objectContaining({ location: { contentType: "Book", field: "remarks" } }),
      expect.objectContaining({ location: { contentType: "Film", field: "pin" } }),
    ]);
    for (const f of laravel.files.filter((f) => f.path !== "resources/camis/schema.json")) {
      expect(f.content).not.toMatch(/subjects|pinned_?[tT]o|'pins'|'remarks'|'pin'/);
    }
  });

  it("are reported on the Strapi storage layout", () => {
    const storage = filamentAdapter.generate(morphRelationsBundle, {
      projectName: "notes",
      apiStyle: "strapi",
      storageLayout: "strapi",
    });
    expect(storage.gaps.gaps.filter((g) => g.feature === "polymorphicRelation")).toHaveLength(2);
    expect(storage.gaps.gaps.filter((g) => g.feature === "polymorphicInverse")).toHaveLength(3);
  });
});
