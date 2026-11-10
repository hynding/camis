import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PHP_MARKER } from "../../hooks/names";
import { filamentAdapter } from "../../generate";
import { strapiApiBundle } from "../__fixtures__/strapi-api";
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
      "../__golden__/strapi-api/StrapiUpload.php",
    );
  });
  it("HasMedia golden", async () => {
    await expect(emitHasMedia()).toMatchFileSnapshot("../__golden__/strapi-api/HasMedia.php");
  });
  it("StrapiFolders golden", async () => {
    await expect(content("app/Support/StrapiFolders.php")).toMatchFileSnapshot(
      "../__golden__/strapi-api/StrapiFolders.php",
    );
  });
  it("MediaPicker golden", async () => {
    await expect(content("app/Filament/Support/MediaPicker.php")).toMatchFileSnapshot(
      "../__golden__/strapi-api/MediaPicker.php",
    );
  });
  it("UploadController golden", async () => {
    await expect(content("app/Http/Controllers/Api/UploadController.php")).toMatchFileSnapshot(
      "../__golden__/strapi-api/UploadController.php",
    );
  });
  it("FileSerializer golden", async () => {
    await expect(content("app/Http/Serializers/FileSerializer.php")).toMatchFileSnapshot(
      "../__golden__/strapi-api/FileSerializer.php",
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
  // A migrated Strapi project on Cloudinary needs only cloudinary-labs/cloudinary-laravel and its
  // keys: the disk is defined here unless config/filesystems.php defines its own.
  it("defines the cloudinary disk a migrated project's provider stores on", () => {
    const config = content("config/camis.php");
    expect(config).toContain("'cloudinary' => [\n                'driver' => 'cloudinary',");
    expect(config).toContain("'cloud' => env('CLOUDINARY_CLOUD_NAME'),");
    expect(content("app/Support/StrapiUpload.php")).toContain(
      'return config("filesystems.disks.{$name}") === null && is_array($fallback) ? Storage::build($fallback) : Storage::disk($name);',
    );
  });
  // Strapi's upload.security: config/plugins.php lists the MIME types an upload may have.
  it("reads the upload allow and deny lists from the environment, unset by default", () => {
    const config = content("config/camis.php");
    expect(config).toContain(
      "'allowed_types' => ($allowed = env('CAMIS_UPLOAD_ALLOWED_TYPES')) === null ? null : array_values(array_filter(array_map('trim', explode(',', (string) $allowed)), 'strlen')),",
    );
    expect(config).toContain(
      "'denied_types' => ($denied = env('CAMIS_UPLOAD_DENIED_TYPES')) === null ? null : array_values(array_filter(array_map('trim', explode(',', (string) $denied)), 'strlen')),",
    );
  });
  it("refuses an upload whose type the lists refuse, before storing it", () => {
    const upload = content("app/Support/StrapiUpload.php");
    expect(upload).toContain("$refused = StrapiMimeTypes::rejection($upload);");
    expect(upload).toContain("throw StrapiError::validation($refused);");
  });
  it("uploads the files the lists let through and refuses only when none is left, as Strapi does", () => {
    const controller = content("app/Http/Controllers/Api/UploadController.php");
    expect(controller).toContain(
      "[$uploads, $infos] = $this->permitted($uploads, $this->infos($request));",
    );
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
  it("are read and written with their entry, whatever the file grants, as Strapi does", () => {
    // Strapi's restricted-relations visitors act on relations only, not on media attributes:
    // a role with no upload grant still populates, filters and links an entry's media.
    const query = content("app/Support/StrapiQuery.php");
    expect(query).toContain(
      "if (in_array($relation['kind'] ?? null, ['mediaOne', 'mediaMany'], true)) {\n            return true;\n        }",
    );
    expect(content("app/Support/StrapiPopulate.php")).toContain(
      "$visible = $media ? $linked : array_values(array_filter($linked, fn (Model $target) => StrapiQuery::visible($target, $viewer)));",
    );
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
  // Strapi links an embedded component's files to the component; here the component is columns of
  // the entry's row, so the entry links them, under the field's path within it.
  it("inside an embedded component are links from the entry, by their path", () => {
    expect(content("_create_storyboards_table.php")).not.toContain("seo_meta_image");
    const storyboard = content("app/Models/Storyboard.php");
    expect(storyboard).toContain("use HasMedia;");
    expect(storyboard).toContain(
      "public function seoMetaImage(): \\Illuminate\\Database\\Eloquent\\Relations\\MorphToMany",
    );
    expect(storyboard).toContain("->withPivotValue('field', 'seo.metaImage')");
    const serializer = content("app/Http/Serializers/StoryboardSerializer.php");
    expect(serializer).toMatch(
      /'seo\.metaImage' => \['relation' => 'seoMetaImage', 'kind' => 'mediaOne',/,
    );
    expect(serializer).toContain("$m->seoMetaImage->first()");
    expect(content("app/Filament/Resources/Storyboards/Schemas/StoryboardForm.php")).toContain(
      "MediaPicker::make('seoMetaImage', multiple: false, allowedTypes: ['image']),",
    );
    expect(result.gaps.gaps.filter((g) => g.feature === "componentMedia")).toEqual([]);
  });
  it("inside a dynamic zone's item are links from the item", () => {
    expect(content("_create_landings_blocks_frame_table.php")).not.toContain("'image'");
    const frame = content("app/Models/LandingBlocksFrame.php");
    expect(frame).toContain("use \\App\\Models\\Concerns\\HasMedia;");
    expect(frame).toContain("->withPivotValue('field', 'image')");
    // The entry's items go one by one, so their links go with them.
    const landing = content("app/Models/Landing.php");
    expect(landing).toContain("use HasMedia;");
    expect(landing).toContain("public const MEDIA_COMPONENTS = ['blocksFrame'];");
    const serializer = content("app/Http/Serializers/LandingSerializer.php");
    expect(serializer).toMatch(
      /'shared\.frame' => \['relation' => 'blocksFrame', 'components' => \['image'\], 'fields' => \[\n\s+'image' => \['relation' => 'image', 'kind' => 'mediaOne',/,
    );
    expect(serializer).toContain("'image' => $c->image->first() === null ? null");
    expect(serializer).toContain("'__links' => array_intersect_key($item, ['image' => true]),");
    expect(content("app/Http/Controllers/Api/Generated/LandingApiController.php")).toContain(
      "StrapiRelations::zones($wire['children'], LandingSerializer::ZONES, ",
    );
    expect(content("app/Filament/Resources/Landings/Schemas/LandingForm.php")).toContain(
      "MediaPicker::ids('image', multiple: false, allowedTypes: ['image']),",
    );
    expect(result.gaps.gaps.filter((g) => g.feature === "componentMedia")).toEqual([]);
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
    const { default: vectors } = await import("../__fixtures__/media-vectors.json");
    const { default: expected } = await import("../__fixtures__/media-vectors.expected.json");
    expect(Object.keys(expected)).toEqual(vectors.writes.map((w) => w.name));
  });
});

describe("upload security", () => {
  it("StrapiMimeTypes golden", async () => {
    await expect(content("app/Support/StrapiMimeTypes.php")).toMatchFileSnapshot(
      "../__golden__/strapi-api/StrapiMimeTypes.php",
    );
  });
  it.skipIf(!hasPhp())("StrapiMimeTypes parses", () => {
    const dir = mkdtempSync(join(tmpdir(), "camis-mime-"));
    const file = join(dir, "f.php");
    writeFileSync(file, content("app/Support/StrapiMimeTypes.php"));
    expect(execFileSync("php", ["-l", file], { encoding: "utf8" })).toContain("No syntax errors");
    rmSync(dir, { recursive: true, force: true });
  });
});
