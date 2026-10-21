import { PHP_MARKER } from "../hooks/names";

const header = (namespace: string): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace ${namespace};\n`;

/** Strapi's own uid for a file, which its relation errors and `ref` name. */
export const FILE_UID = "plugin::upload.file";

export const FILES_MIGRATION_PATH = "database/migrations/0001_01_02_000000_create_files_table.php";

/**
 * Strapi 5's upload plugin on a Laravel filesystem disk: a file keeps Strapi's `files` row shape
 * (hash, ext, mime, size in kB, url, responsive formats), and images larger than a breakpoint get
 * Strapi's formats — thumbnail (245×156), large (1000), medium (750), small (500), each fit inside
 * its box — resized with GD, so nothing beyond PHP's bundled extension is needed on a shared host.
 * The default disk is public/uploads, served by the web server at /uploads as Strapi's local
 * provider serves it; CAMIS_UPLOAD_DISK names any Laravel disk instead (S3, Cloudinary through
 * their filesystem drivers). The canonical check is `media-vectors.json`, recorded from strapi-php.
 */
export const emitStrapiUpload = (model = "File"): string =>
  header("App\\Support") +
  String.raw`
use ${`App\\Models\\${model}`};
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Throwable;

final class StrapiUpload
{
    /** Strapi's responsive breakpoints, in the order its formats list them. */
    private const BREAKPOINTS = ['large' => 1000, 'medium' => 750, 'small' => 500];

    private const THUMBNAIL = [245, 156];

    /** The images GD can resize; any other file keeps no formats. */
    private const RESIZABLE = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

    /** Stores an uploaded file with its info (name, alternativeText, caption) and formats. */
    public static function store(UploadedFile $upload, array $info): ${model}
    {
        $file = new ${model}();
        $file->name = $upload->getClientOriginalName();
        // Before put(): a format's name is the file's, as the info names it.
        self::describe($file, $info);
        self::put($file, $upload);
        $file->published_at = now();
        $file->save();

        return $file;
    }

    /** A file the admin received in a temporary path, stored as an upload would be. */
    public static function storePath(string $path, string $originalName, array $info): ${model}
    {
        return self::store(new UploadedFile($path, $originalName, null, null, true), $info);
    }

    /** Edits a file's info and, when given a new upload, replaces what it stores. */
    public static function update(${model} $file, array $info, ?UploadedFile $upload): ${model}
    {
        self::describe($file, $info);
        if ($upload !== null) {
            self::forget($file);
            self::put($file, $upload);
        }
        $file->save();

        return $file;
    }

    /** Removes what a file stores: the original and each format. Its row is the caller's. */
    public static function forget(${model} $file): void
    {
        $disk = self::disk();
        $disk->delete(array_map(
            fn (array $stored): string => $stored['hash'].$stored['ext'],
            [['hash' => $file->hash, 'ext' => $file->ext], ...array_values($file->formats ?? [])],
        ));
    }

    /** Links a file to an entry's media field: one replaces a single file, a list appends. */
    public static function attach(Model $entry, array $relation, ${model} $file): void
    {
        $media = $entry->{$relation['relation']}();
        if ($relation['kind'] === 'mediaOne') {
            $media->sync([$file->getKey() => ['order' => 1]]);

            return;
        }
        $last = $media->newPivotQuery()->max('order');
        $media->attach($file->getKey(), ['order' => ((int) $last) + 1]);
    }

    /** A file as the upload API answers with it. */
    public static function wire(${model} $file): array
    {
        return [...${`\\App\\Http\\Serializers\\${model}`}Serializer::toWire($file), 'isUrlSigned' => false];
    }

    public static function disk(): Filesystem
    {
        $name = config('camis.upload.disk');
        if ($name !== null && $name !== '') {
            return Storage::disk($name);
        }

        return Storage::build(['driver' => 'local', 'root' => public_path('uploads'), 'url' => '/uploads', 'visibility' => 'public', 'throw' => true]);
    }

    private static function put(${model} $file, UploadedFile $upload): void
    {
        if (! $upload->isValid()) {
            throw StrapiError::validation($upload->getErrorMessage());
        }
        $limit = (int) config('camis.upload.size_limit', 209715200);
        if ($upload->getSize() > $limit) {
            $megabytes = round($limit / 1000000, 2);
            throw new StrapiError(413, 'PayloadTooLargeError', "{$upload->getClientOriginalName()} exceeds size limit of {$megabytes}MB.");
        }
        // As Strapi's formatFileInfo: the extension is the upload's, the hash is the file's name
        // (which fileInfo may have set) without that extension.
        $original = $upload->getClientOriginalName();
        $ext = pathinfo($original, PATHINFO_EXTENSION) === '' ? '' : '.'.strtolower(pathinfo($original, PATHINFO_EXTENSION));
        $name = (string) ($file->name ?? $original);
        $hash = self::hash($ext !== '' && str_ends_with(strtolower($name), $ext) ? substr($name, 0, -strlen($ext)) : $name);
        $mime = $upload->getMimeType() ?: ($upload->getClientMimeType() ?: 'application/octet-stream');
        $disk = self::disk();
        $disk->putFileAs('', $upload, $hash.$ext);
        [$width, $height] = str_starts_with($mime, 'image/') ? self::dimensions($upload->getRealPath()) : [null, null];
        $file->forceFill([
            'hash' => $hash,
            'ext' => $ext,
            'mime' => $mime,
            'size' => self::kilobytes((int) $upload->getSize()),
            'url' => $disk->url($hash.$ext),
            'provider' => (string) (config('camis.upload.provider') ?? (config('camis.upload.disk') ?? 'local')),
            'width' => $width,
            'height' => $height,
            'formats' => $width === null ? null : self::formats($upload->getRealPath(), $mime, $width, $height, $hash, $ext, (string) $file->name, $disk),
        ]);
    }

    /** name, alternativeText and caption, each kept when the info leaves it out. */
    private static function describe(${model} $file, array $info): void
    {
        foreach (['name' => 'name', 'alternativeText' => 'alternative_text', 'caption' => 'caption'] as $key => $column) {
            if (isset($info[$key]) && is_string($info[$key])) {
                $file->setAttribute($column, $info[$key]);
            }
        }
    }

    /** Strapi's file hash: the name slugged with underscores, then ten random hex digits. */
    private static function hash(string $name): string
    {
        $slug = preg_replace('/([a-z\d])([A-Z])/', '$1_$2', Str::ascii($name)) ?? '';
        $slug = trim(preg_replace('/[^A-Za-z0-9]+/', '_', $slug) ?? '', '_');

        return ($slug === '' ? 'file' : $slug).'_'.bin2hex(random_bytes(5));
    }

    private static function kilobytes(int $bytes): float
    {
        return round($bytes / 1000, 2);
    }

    /** @return array{0: ?int, 1: ?int} */
    private static function dimensions(string|false $path): array
    {
        $size = $path === false ? false : @getimagesize($path);

        return $size === false ? [null, null] : [(int) $size[0], (int) $size[1]];
    }

    /** @return array<string, array>|null */
    private static function formats(string|false $path, string $mime, int $width, int $height, string $hash, string $ext, string $name, Filesystem $disk): ?array
    {
        if ($path === false || ! in_array($mime, self::RESIZABLE, true) || ! function_exists('imagecreatefromstring')) {
            return null;
        }
        try {
            $source = imagecreatefromstring((string) file_get_contents($path));
            if ($source === false) {
                return null;
            }
            $formats = [];
            [$thumbWidth, $thumbHeight] = self::THUMBNAIL;
            if ($width > $thumbWidth || $height > $thumbHeight) {
                $formats['thumbnail'] = self::format('thumbnail', $source, $thumbWidth, $thumbHeight, $mime, $hash, $ext, $name, $disk);
            }
            foreach (self::BREAKPOINTS as $key => $breakpoint) {
                if ($width > $breakpoint || $height > $breakpoint) {
                    $formats[$key] = self::format($key, $source, $breakpoint, $breakpoint, $mime, $hash, $ext, $name, $disk);
                }
            }
        } catch (Throwable) {
            // An image GD cannot decode, or one too large for the memory limit, keeps no formats.
            return null;
        }

        return $formats === [] ? null : $formats;
    }

    private static function format(string $key, \GdImage $source, int $boxWidth, int $boxHeight, string $mime, string $hash, string $ext, string $name, Filesystem $disk): array
    {
        $sourceWidth = imagesx($source);
        $sourceHeight = imagesy($source);
        $scale = min($boxWidth / $sourceWidth, $boxHeight / $sourceHeight);
        $width = max(1, (int) round($sourceWidth * $scale));
        $height = max(1, (int) round($sourceHeight * $scale));
        $resized = imagecreatetruecolor($width, $height);
        if ($mime !== 'image/jpeg') {
            imagealphablending($resized, false);
            imagesavealpha($resized, true);
            imagefill($resized, 0, 0, (int) imagecolorallocatealpha($resized, 0, 0, 0, 127));
        }
        imagecopyresampled($resized, $source, 0, 0, 0, 0, $width, $height, $sourceWidth, $sourceHeight);
        ob_start();
        match ($mime) {
            'image/jpeg' => imagejpeg($resized, null, 80),
            'image/png' => imagepng($resized, null, 9),
            'image/webp' => imagewebp($resized, null, 80),
            default => imagegif($resized),
        };
        $bytes = (string) ob_get_clean();
        $disk->put("{$key}_{$hash}{$ext}", $bytes);

        return [
            'name' => "{$key}_{$name}",
            'hash' => "{$key}_{$hash}",
            'ext' => $ext,
            'mime' => $mime,
            'path' => null,
            'width' => $width,
            'height' => $height,
            'size' => self::kilobytes(strlen($bytes)),
            'sizeInBytes' => strlen($bytes),
            'url' => $disk->url("{$key}_{$hash}{$ext}"),
        ];
    }
}
`;

/** The model half of a type with media fields: its links go when it does. */
export const emitHasMedia = (): string =>
  header("App\\Models\\Concerns") +
  String.raw`
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

trait HasMedia
{
    protected static function bootHasMedia(): void
    {
        static::deleting(function (Model $row): void {
            DB::table('files_related_mph')
                ->where('related_type', $row->getMorphClass())
                ->where('related_id', $row->getKey())
                ->delete();
        });
    }
}
`;

/** One media field of an entry: the files the link table holds for it, in their order. */
export const mediaRelationMethod = (field: string, method: string, model = "File"): string =>
  `    public function ${method}(): \\Illuminate\\Database\\Eloquent\\Relations\\MorphToMany
    {
        return $this->morphToMany(\\App\\Models\\${model}::class, 'related', 'files_related_mph', 'related_id', 'file_id')
            ->withPivotValue('field', '${field}')
            ->withPivot('order');
    }`;

/** Strapi's files table, and its link table from files to the entries that use them. */
export const emitFilesMigration = (): string => `<?php

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('files', function (Blueprint $table): void {
            $table->id();
            $table->string('document_id', 24)->unique();
            $table->string('name');
            $table->string('alternative_text')->nullable();
            $table->text('caption')->nullable();
            $table->json('focal_point')->nullable();
            $table->integer('width')->nullable();
            $table->integer('height')->nullable();
            $table->json('formats')->nullable();
            $table->string('hash')->index();
            $table->string('ext')->nullable();
            $table->string('mime')->index();
            $table->decimal('size', 10, 2);
            $table->text('url');
            $table->text('preview_url')->nullable();
            $table->string('provider');
            $table->json('provider_metadata')->nullable();
            $table->string('folder_path')->default('/')->index();
            $table->timestamps();
            $table->timestamp('published_at')->nullable();
        });
        Schema::create('files_related_mph', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('file_id')->constrained('files')->cascadeOnDelete();
            $table->unsignedBigInteger('related_id');
            $table->string('related_type');
            $table->string('field');
            $table->double('order')->default(0);
            $table->index(['related_type', 'related_id', 'field']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('files_related_mph');
        Schema::dropIfExists('files');
    }
};
`;

/** The file model: Strapi's columns, its formats as an array, and its stored files removed with it. */
export const emitFileModel = (model: string, members: string[]): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Models;

use App\\Models\\Concerns\\EmitsStrapiEvents;
use App\\Models\\Concerns\\HasDocumentId;
use App\\Support\\StrapiUpload;${members.length > 0 ? "\nuse Illuminate\\Database\\Eloquent\\Builder;" : ""}
use Illuminate\\Database\\Eloquent\\Model;

class ${model} extends Model
{
    use EmitsStrapiEvents;
    use HasDocumentId;

    protected $table = 'files';

    protected $fillable = [
        'name',
        'alternative_text',
        'caption',
    ];

    protected function casts(): array
    {
        return [
            'focal_point' => 'array',
            'formats' => 'array',
            'provider_metadata' => 'array',
            'width' => 'integer',
            'height' => 'integer',
            'size' => 'float',
            'published_at' => 'datetime',
        ];
    }

    protected static function booted(): void
    {
        static::deleting(fn (${model} $file) => StrapiUpload::forget($file));
    }
${members.map((m) => `\n${m}\n`).join("")}}
`;

const FILE_FIELDS: { key: string; column: string; type: string }[] = [
  { key: "id", column: "id", type: "integer" },
  { key: "documentId", column: "document_id", type: "string" },
  { key: "name", column: "name", type: "string" },
  { key: "alternativeText", column: "alternative_text", type: "string" },
  { key: "caption", column: "caption", type: "text" },
  { key: "focalPoint", column: "focal_point", type: "json" },
  { key: "width", column: "width", type: "integer" },
  { key: "height", column: "height", type: "integer" },
  { key: "formats", column: "formats", type: "json" },
  { key: "hash", column: "hash", type: "string" },
  { key: "ext", column: "ext", type: "string" },
  { key: "mime", column: "mime", type: "string" },
  { key: "size", column: "size", type: "decimal" },
  { key: "url", column: "url", type: "text" },
  { key: "previewUrl", column: "preview_url", type: "text" },
  { key: "provider", column: "provider", type: "string" },
  { key: "provider_metadata", column: "provider_metadata", type: "json" },
  { key: "createdAt", column: "created_at", type: "dateTime" },
  { key: "updatedAt", column: "updated_at", type: "dateTime" },
  { key: "publishedAt", column: "published_at", type: "dateTime" },
];

const ZULU_MS = "?->toIso8601ZuluString('millisecond')";
const fileWire = (column: string, type: string): string => {
  const col = `$m->${column}`;
  if (type === "dateTime") return `${col}${ZULU_MS}`;
  return col;
};

/**
 * A file on the wire, nulls included, as Strapi sends it; FIELDS lets the upload API and populate
 * filter, sort and select by its keys. A file links nothing, so it has no relations of its own.
 */
export const emitFileSerializer = (model: string): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Serializers;

use App\\Models\\${model};

final class ${model}Serializer
{
    /** Wire path → column, for StrapiQuery's filters, sort and fields. */
    public const FIELDS = [
${FILE_FIELDS.map((f) => `        '${f.key}' => ['column' => '${f.column}', 'type' => '${f.type}'],`).join("\n")}
    ];

    public const COMPONENTS = [];

    public const DRAFT_PUBLISH = false;

    public const LOCALIZED = false;

    public static function toWire(${model} $m): array
    {
        return [
${FILE_FIELDS.map((f) => `            '${f.key}' => ${fileWire(f.column, f.type)},`).join("\n")}
        ];
    }
}
`;

export interface UploadTarget {
  uid: string;
  model: string;
}

/**
 * Strapi's upload Content API. POST /upload stores the `files` it receives, each with the
 * `fileInfo` at its position, and links them to an entry's media field when `ref`, `refId` and
 * `field` name one; with `?id=` it edits that file instead. GET lists or shows files, DELETE
 * removes one with what it stores. Every route is behind the grants on the media library, and a
 * linked entry behind its own update grant.
 */
export const emitUploadController = (
  model: string,
  targets: UploadTarget[],
  secured: boolean,
): string => {
  const S = `${model}Serializer`;
  const auth = (statement: string): string => (secured ? `        ${statement}\n` : "");
  const files = secured ? `${model}::query()->forUser($request->user())` : `${model}::query()`;
  const visible = (v: string): string => (secured ? ` || ! Gate::allows('view', ${v})` : "");
  const listed = secured ? `->filter(fn (${model} $file) => Gate::allows('view', $file))` : "";
  const target = targets
    .map(
      (t) =>
        `        '${t.uid}' => [\\App\\Models\\${t.model}::class, \\App\\Http\\Serializers\\${t.model}Serializer::class],`,
    )
    .join("\n");
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Http\\Serializers\\${S};
use App\\Models\\${model};
use App\\Support\\StrapiError;
use App\\Support\\StrapiQuery;
use App\\Support\\StrapiUpload;
use Illuminate\\Database\\Eloquent\\Builder;
use Illuminate\\Foundation\\Auth\\Access\\AuthorizesRequests;
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\Request;
use Illuminate\\Http\\UploadedFile;
use Illuminate\\Support\\Facades\\DB;${secured ? "\nuse Illuminate\\Support\\Facades\\Gate;" : ""}

class UploadController extends Controller
{
    use AuthorizesRequests;

    /** Each type with media fields, by Strapi uid: what an upload's \`ref\` may name. */
    private const TARGETS = [
${target}
    ];

    public function upload(Request $request): JsonResponse
    {
        if ($request->query('id') !== null) {
            return $this->updateInfo($request, (string) $request->query('id'));
        }
${auth(`$this->authorize('create', ${model}::class);`)}        $uploads = $this->uploads($request);
        if ($uploads === []) {
            throw StrapiError::validation('Files are empty');
        }
        $infos = $this->infos($request);
        $entry = $this->entry($request);
        $stored = DB::transaction(function () use ($uploads, $infos, $entry): array {
            $stored = [];
            foreach ($uploads as $i => $upload) {
                $file = StrapiUpload::store($upload, $infos[$i] ?? []);
                if ($entry !== null) {
                    StrapiUpload::attach($entry['row'], $entry['relation'], $file);
                }
                $stored[] = $file;
            }

            return $stored;
        });

        return response()->json(array_map(fn (${model} $file) => StrapiUpload::wire($file), $stored), 201);
    }

    public function find(Request $request): JsonResponse
    {
${auth(`$this->authorize('viewAny', ${model}::class);`)}        $params = $request->query();
        $query = $this->files($request);
        StrapiQuery::filter($query, $params, ${S}::FIELDS, $request->user(), null);
        StrapiQuery::order($query, $params['sort'] ?? null, ${S}::FIELDS, $request->user());

        return response()->json($query->get()${listed}
            ->map(fn (${model} $file) => StrapiQuery::select(StrapiUpload::wire($file), $params, ${S}::FIELDS))
            ->values()
            ->all());
    }

    /** Strapi's findOne reads only populate, so fields and filters do not narrow it. */
    public function findOne(Request $request, string $id): JsonResponse
    {
        return response()->json(StrapiUpload::wire($this->file($request, $id, 'file.notFound')));
    }

    public function destroy(Request $request, string $id): JsonResponse
    {
        $file = $this->file($request, $id, 'file.notFound');
${auth(`$this->authorize('delete', $file);`)}        $wire = StrapiUpload::wire($file);
        DB::transaction(fn () => $file->delete());

        return response()->json($wire);
    }

    private function updateInfo(Request $request, string $id): JsonResponse
    {
        $file = $this->file($request, $id, 'Entity not found');
${auth(`$this->authorize('update', $file);`)}        $upload = $this->uploads($request)[0] ?? null;
        $file = DB::transaction(fn () => StrapiUpload::update($file, $this->infos($request)[0] ?? [], $upload));

        return response()->json(StrapiUpload::wire($file));
    }

    private function files(Request $request): Builder
    {
        return ${files};
    }

    private function file(Request $request, string $id, string $missing): ${model}
    {
        $file = ctype_digit($id) ? $this->files($request)->find((int) $id) : null;
        if ($file === null${visible("$file")}) {
            throw new StrapiError(404, 'NotFoundError', $missing);
        }

        return $file;
    }

    /** @return list<UploadedFile> the request's \`files\` (or \`files[]\`), in order */
    private function uploads(Request $request): array
    {
        $files = $request->file('files');
        $files = $files instanceof UploadedFile ? [$files] : (is_array($files) ? $files : []);

        return array_values(array_filter($files, fn (mixed $f): bool => $f instanceof UploadedFile));
    }

    /** @return list<array> each file's fileInfo, sent as JSON text or as form fields */
    private function infos(Request $request): array
    {
        $info = $request->input('fileInfo');
        if ($info === null) {
            return [];
        }
        $infos = is_array($info) && array_is_list($info) ? $info : [$info];

        return array_map(function (mixed $one): array {
            $decoded = is_string($one) ? json_decode($one, true) : $one;
            if (! is_array($decoded)) {
                throw StrapiError::validation('fileInfo must be an object');
            }

            return $decoded;
        }, $infos);
    }

    /** The entry and media field an upload's ref, refId and field name, or null without them. */
    private function entry(Request $request): ?array
    {
        $ref = $request->input('ref');
        if ($ref === null) {
            return null;
        }
        [$modelClass, $serializer] = self::TARGETS[$ref] ?? [null, null];
        $field = (string) $request->input('field');
        $relation = $serializer === null ? null : ($serializer::FIELDS[$field] ?? null);
        if ($relation === null || ! in_array($relation['kind'] ?? null, ['mediaOne', 'mediaMany'], true)) {
            throw StrapiError::validation("Invalid ref, refId or field: {$ref}.{$field}");
        }
        $query = $modelClass::query();
${secured ? "        $query->forUser($request->user());\n" : ""}        $row = $query->find($request->input('refId'));
        if ($row === null${visible("$row")}) {
            throw new StrapiError(404, 'NotFoundError', 'Entity not found');
        }
${auth("$this->authorize('update', $row);")}
        return ['row' => $row, 'relation' => $relation];
    }
}
`;
};

/**
 * The admin's media field: files picked from the media library (one, or a list in order), and a
 * new one uploaded into it in place.
 */
export const emitMediaPicker = (model: string): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Filament\\Support;

use App\\Support\\StrapiUpload;
use Filament\\Forms\\Components\\FileUpload;
use Filament\\Forms\\Components\\Select;
use Filament\\Forms\\Components\\TextInput;
use Illuminate\\Support\\Facades\\Storage;

final class MediaPicker
{
    public static function make(string $field, bool $multiple): Select
    {
        return Select::make($field)
            ->relationship(name: $field, titleAttribute: 'name')
            ->multiple()
            ->maxItems($multiple ? null : 1)
            ->preload()
            ->searchable()
            ->createOptionForm(self::uploadForm())
            ->createOptionUsing(fn (array $data): int => (int) self::store($data)->getKey());
    }

    /** @return list<\\Filament\\Schemas\\Components\\Component|\\Filament\\Forms\\Components\\Field> */
    public static function uploadForm(): array
    {
        return [
            FileUpload::make('upload')->disk('local')->directory('camis-uploads')->storeFileNamesIn('original_name')->required(),
            TextInput::make('alternative_text'),
            TextInput::make('caption'),
        ];
    }

    /** Moves an admin upload from Filament's temporary disk into the media library. */
    public static function store(array $data): \\App\\Models\\${model}
    {
        $disk = Storage::disk('local');
        $path = (string) $data['upload'];
        try {
            return StrapiUpload::storePath($disk->path($path), (string) ($data['original_name'] ?? basename($path)), [
                'alternativeText' => $data['alternative_text'] ?? null,
                'caption' => $data['caption'] ?? null,
            ]);
        } finally {
            $disk->delete($path);
        }
    }
}
`;

/** The media library in the admin: a list with previews, an upload page, and an info editor. */
export const emitFileResourceFiles = (
  model: string,
  dir: string,
  plural: string,
): { path: string; content: string }[] => {
  const ns = `App\\Filament\\Resources\\${dir}`;
  const resource = `${model}Resource`;
  const page = (cls: string, base: string, body = ""): string => `<?php

declare(strict_types=1);

namespace ${ns}\\Pages;

use ${ns}\\${resource};
use Filament\\Resources\\Pages\\${base};${body.includes("MediaPicker") ? "\nuse App\\Filament\\Support\\MediaPicker;\nuse Illuminate\\Database\\Eloquent\\Model;" : ""}

class ${cls} extends ${base}
{
    protected static string $resource = ${resource}::class;${body}
}
`;
  return [
    {
      path: `app/Filament/Resources/${dir}/${resource}.php`,
      content: `<?php

declare(strict_types=1);

namespace ${ns};

use App\\Filament\\Support\\MediaPicker;
use App\\Models\\${model};
use BackedEnum;
use ${ns}\\Pages\\Create${model};
use ${ns}\\Pages\\Edit${model};
use ${ns}\\Pages\\List${plural};
use Filament\\Forms\\Components\\TextInput;
use Filament\\Resources\\Resource;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Columns\\ImageColumn;
use Filament\\Tables\\Columns\\TextColumn;
use Filament\\Tables\\Table;

class ${resource} extends Resource
{
    protected static ?string $model = ${model}::class;

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-photo';

    protected static ?string $navigationLabel = 'Media Library';

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            ...array_map(
                fn ($component) => $component->visibleOn('create'),
                MediaPicker::uploadForm(),
            ),
            TextInput::make('name')->required()->visibleOn('edit'),
            TextInput::make('alternative_text')->visibleOn('edit'),
            TextInput::make('caption')->visibleOn('edit'),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table->columns([
            ImageColumn::make('preview')->state(fn (${model} $record): ?string => str_starts_with((string) $record->mime, 'image/') ? ($record->formats['thumbnail']['url'] ?? $record->url) : null),
            TextColumn::make('name')->searchable()->sortable(),
            TextColumn::make('ext'),
            TextColumn::make('size')->suffix(' kB')->sortable(),
            TextColumn::make('created_at')->dateTime()->sortable(),
        ])->defaultSort('created_at', 'desc');
    }

    public static function getPages(): array
    {
        return [
            'index' => List${plural}::route('/'),
            'create' => Create${model}::route('/create'),
            'edit' => Edit${model}::route('/{record}/edit'),
        ];
    }
}
`,
    },
    {
      path: `app/Filament/Resources/${dir}/Pages/List${plural}.php`,
      content: page(`List${plural}`, "ListRecords"),
    },
    {
      path: `app/Filament/Resources/${dir}/Pages/Create${model}.php`,
      content: page(
        `Create${model}`,
        "CreateRecord",
        `

    /** An admin upload is stored as one through the API is. */
    protected function handleRecordCreation(array $data): Model
    {
        return MediaPicker::store($data);
    }`,
      ),
    },
    {
      path: `app/Filament/Resources/${dir}/Pages/Edit${model}.php`,
      content: page(`Edit${model}`, "EditRecord"),
    },
  ];
};
