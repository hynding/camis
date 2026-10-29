import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHP_MARKER } from "../hooks/names";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { emitHasMedia, emitStrapiUpload } from "./media-runtime";

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

const generated = [
  "app/Support/StrapiUpload.php",
  "app/Models/Concerns/HasMedia.php",
  "app/Models/File.php",
  "app/Http/Serializers/FileSerializer.php",
  "app/Http/Controllers/Api/UploadController.php",
  "app/Filament/Support/MediaPicker.php",
  "app/Filament/Resources/Files/FileResource.php",
  "app/Filament/Resources/Files/Pages/CreateFile.php",
  "app/Filament/Resources/Files/Pages/EditFile.php",
  "app/Filament/Resources/Files/Pages/ListFiles.php",
  "app/Policies/FilePolicy.php",
  "_create_files_table.php",
  "app/Models/UploadFolder.php",
  "app/Support/StrapiFolders.php",
  "app/Policies/UploadFolderPolicy.php",
  "app/Filament/Resources/UploadFolders/UploadFolderResource.php",
  "app/Filament/Resources/UploadFolders/Pages/CreateUploadFolder.php",
  "app/Filament/Resources/UploadFolders/Pages/EditUploadFolder.php",
  "app/Filament/Resources/UploadFolders/Pages/ListUploadFolders.php",
  "_create_upload_folders_table.php",
];

describe("media runtime files", () => {
  it.each([
    { path: "app/Support/StrapiUpload.php", namespace: "App\\Support" },
    { path: "app/Models/Concerns/HasMedia.php", namespace: "App\\Models\\Concerns" },
  ])("$path is generated, marked, strict and namespaced", ({ path, namespace }) => {
    const php = content(path);
    expect(php.startsWith(`<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n`)).toBe(true);
    expect(php).toContain(`namespace ${namespace};`);
  });
  it("StrapiUpload golden", async () => {
    await expect(emitStrapiUpload()).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiUpload.php",
    );
  });
  it("HasMedia golden", async () => {
    await expect(emitHasMedia()).toMatchFileSnapshot("./__golden__/strapi-api/HasMedia.php");
  });
  it("StrapiFolders golden", async () => {
    await expect(content("app/Support/StrapiFolders.php")).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiFolders.php",
    );
  });
  it("MediaPicker golden", async () => {
    await expect(content("app/Filament/Support/MediaPicker.php")).toMatchFileSnapshot(
      "./__golden__/strapi-api/MediaPicker.php",
    );
  });
  it("UploadController golden", async () => {
    await expect(content("app/Http/Controllers/Api/UploadController.php")).toMatchFileSnapshot(
      "./__golden__/strapi-api/UploadController.php",
    );
  });
  it("FileSerializer golden", async () => {
    await expect(content("app/Http/Serializers/FileSerializer.php")).toMatchFileSnapshot(
      "./__golden__/strapi-api/FileSerializer.php",
    );
  });
  describe.skipIf(!hasPhp())("php -l", () => {
    let dir = "";
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "camis-media-"));
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    it.each(generated)("%s parses", (path) => {
      const file = join(dir, "f.php");
      writeFileSync(file, content(path));
      expect(execFileSync("php", ["-l", file], { encoding: "utf8" })).toContain("No syntax errors");
    });
  });
});

describe("the media library", () => {
  it("keeps Strapi's files table and the table linking files to entries", () => {
    const migration = content("_create_files_table.php");
    expect(migration).toContain("Schema::create('files'");
    expect(migration).toContain("Schema::create('files_related_mph'");
    expect(migration).toContain(
      "$table->foreignId('file_id')->constrained('files')->cascadeOnDelete();",
    );
    expect(content("app/Models/File.php")).toContain("protected $table = 'files';");
  });
  it("is served at Strapi's upload routes, behind the caller's grants", () => {
    const routes = content("routes/api.php");
    for (const route of [
      "Route::post('/upload', [UploadController::class, 'upload']);",
      "Route::get('/upload/files', [UploadController::class, 'find']);",
      "Route::get('/upload/files/{id}', [UploadController::class, 'findOne']);",
      "Route::delete('/upload/files/{id}', [UploadController::class, 'destroy']);",
    ]) {
      expect(routes).toContain(route);
    }
    const controller = content("app/Http/Controllers/Api/UploadController.php");
    expect(controller).toContain("$this->authorize('create', File::class);");
    expect(controller).toContain("$this->authorize('update', $file);");
    expect(controller).toContain("$this->authorize('delete', $file);");
    expect(content("app/Policies/FilePolicy.php")).toContain("class FilePolicy");
    expect(content("app/Models/File.php")).toContain("public function scopeForUser(");
  });
  it("links an upload to an entry's media field", () => {
    expect(content("app/Http/Controllers/Api/UploadController.php")).toContain(
      "'api::book.book' => [\\App\\Models\\Book::class, \\App\\Http\\Serializers\\BookSerializer::class],",
    );
  });
  it("stores files on a configured disk, public/uploads by default", () => {
    const config = content("config/camis.php");
    expect(config).toContain("'disk' => env('CAMIS_UPLOAD_DISK'),");
    expect(config).toContain("'size_limit' => (int) env('CAMIS_UPLOAD_SIZE_LIMIT', 209715200),");
  });
  it("is browsed and filled in the admin", () => {
    const resource = content("app/Filament/Resources/Files/FileResource.php");
    expect(resource).toContain("protected static ?string $model = File::class;");
    expect(resource).toContain("'Media Library'");
    expect(content("app/Filament/Resources/Files/Pages/CreateFile.php")).toContain(
      "return MediaPicker::store($data);",
    );
    expect(content("app/Filament/Support/MediaPicker.php")).toContain("StrapiUpload::storePath(");
  });
});

describe("the media library's folders", () => {
  it("keep Strapi's upload_folders table, and each file's folder beside its folder path", () => {
    const migration = content("_create_upload_folders_table.php");
    expect(migration).toContain("Schema::create('upload_folders'");
    expect(migration).toContain("$table->unsignedInteger('path_id')->unique();");
    expect(migration).toContain("$table->string('path')->unique();");
    expect(migration).toContain("Schema::table('files'");
    expect(migration).toContain("$table->unsignedBigInteger('folder_id')->nullable()->index();");
    // After the files table, so a project that already ran it gains the folders on migrate.
    const files = result.files.find((f) => f.path.endsWith("_create_files_table.php"))!.path;
    const folders = result.files.find((f) =>
      f.path.endsWith("_create_upload_folders_table.php"),
    )!.path;
    expect(folders > files).toBe(true);
    expect(content("app/Models/UploadFolder.php")).toContain(
      "protected $table = 'upload_folders';",
    );
    expect(content("app/Models/File.php")).toContain("public function folder(): BelongsTo");
  });
  it("hold API uploads in Strapi's API Uploads folder", () => {
    expect(content("app/Http/Controllers/Api/UploadController.php")).toContain(
      "['folder' => StrapiFolders::apiUploads()->getKey()]",
    );
  });
  it("are browsed, made and moved in the admin behind the file grants", () => {
    const resource = content("app/Filament/Resources/UploadFolders/UploadFolderResource.php");
    expect(resource).toContain("protected static ?string $model = UploadFolder::class;");
    expect(resource).toContain("protected static ?string $navigationParentItem = 'Media Library';");
    const policy = content("app/Policies/UploadFolderPolicy.php");
    expect(policy).toContain("return $user->can('file.read');");
    expect(policy).toContain("return $user->can('file.delete');");
    const files = content("app/Filament/Resources/Files/FileResource.php");
    expect(files).toContain("SelectFilter::make('folder')");
    expect(files).toContain("BulkAction::make('move')");
  });
});

describe("media fields", () => {
  it("are links, not columns", () => {
    expect(content("_create_books_table.php")).not.toContain("'cover'");
    const book = content("app/Models/Book.php");
    expect(book).toContain("use HasMedia;");
    expect(book).toContain(
      "public function cover(): \\Illuminate\\Database\\Eloquent\\Relations\\MorphToMany",
    );
    expect(book).toContain("->withPivotValue('field', 'cover')");
    expect(book).not.toContain("'cover' => ");
  });
  it("are populated like relations to the files", () => {
    const book = content("app/Http/Serializers/BookSerializer.php");
    expect(book).toContain(
      "'cover' => ['relation' => 'cover', 'kind' => 'mediaOne', 'model' => \\App\\Models\\File::class, 'serializer' => FileSerializer::class, 'foreignKey' => null, 'uid' => 'plugin::upload.file', 'holder' => 'self', 'draftPublish' => false, 'localized' => false, 'order' => null, 'inverseOrder' => null],",
    );
    expect(book).toMatch(/'attachments' => \['relation' => 'attachments', 'kind' => 'mediaMany',/);
    expect(book).not.toContain("$m->cover");
  });
  it("are picked from, or uploaded to, the media library in the admin", () => {
    const form = content("app/Filament/Resources/Books/Schemas/BookForm.php");
    expect(form).toContain("MediaPicker::make('cover', multiple: false, allowedTypes: ['image']),");
    expect(form).toContain("MediaPicker::make('attachments', multiple: true),");
    expect(form).not.toContain("FileUpload::make('cover')");
  });
  it("are reported when no grant lets anyone use the media library", () => {
    const withoutFiles = {
      ...strapiApiBundle,
      document: {
        ...strapiApiBundle.document,
        contentTypes: strapiApiBundle.document.contentTypes.filter((ct) => ct.builtin !== "file"),
      },
      roles: strapiApiBundle.roles.map((r) => ({
        ...r,
        grants: r.grants.filter((g) => g.contentType !== "File"),
      })),
    };
    const out = filamentAdapter.generate(withoutFiles, { projectName: "oyl", apiStyle: "strapi" });
    expect(out.gaps.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: "media", location: { contentType: "File" } }),
      ]),
    );
    expect(out.files.some((f) => f.path === "app/Models/File.php")).toBe(true);
    expect(
      filamentAdapter
        .generate(strapiApiBundle, { projectName: "oyl", apiStyle: "strapi" })
        .gaps.gaps.filter((g) => g.feature === "media"),
    ).toEqual([]);
  });
  it("stay path columns on the Laravel API style", () => {
    const laravel = filamentAdapter.generate(strapiApiBundle, { projectName: "oyl" });
    const migration = laravel.files.find((f) => f.path.endsWith("_create_books_table.php"))!;
    expect(migration.content).toContain("$table->string('cover')");
    expect(laravel.files.some((f) => f.path === "app/Support/StrapiUpload.php")).toBe(false);
  });
});

describe("media vectors", () => {
  it("are recorded for every write", async () => {
    const { default: vectors } = await import("./__fixtures__/media-vectors.json");
    const { default: expected } = await import("./__fixtures__/media-vectors.expected.json");
    expect(Object.keys(expected)).toEqual(vectors.writes.map((w) => w.name));
  });
});
