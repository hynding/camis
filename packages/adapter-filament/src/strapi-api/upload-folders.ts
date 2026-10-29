import { PHP_MARKER } from "../hooks/names";
import { permissionKey } from "../permissions/keys";

const header = (namespace: string): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace ${namespace};\n`;

/** Strapi's own uid for a media library folder, which export archives name. */
export const FOLDER_UID = "plugin::upload.folder";

/** After the files table and the link order columns, so a project that ran those gains folders on migrate. */
export const UPLOAD_FOLDERS_MIGRATION_PATH =
  "database/migrations/0001_01_03_000001_create_upload_folders_table.php";

/**
 * Strapi's `upload_folders`, and each file's folder beside the folder path the files table keeps.
 * A folder's path is its ancestors' path ids then its own (`/1/2`), as Strapi builds it; a file's
 * folder path is its folder's path, `/` at the library's root.
 */
export const emitUploadFoldersMigration = (): string => `<?php

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('upload_folders', function (Blueprint $table): void {
            $table->id();
            $table->string('document_id', 24)->unique();
            $table->string('name');
            $table->unsignedInteger('path_id')->unique();
            $table->string('path')->unique();
            $table->unsignedBigInteger('parent_id')->nullable()->index();
            $table->timestamps();
            $table->timestamp('published_at')->nullable();
        });
        Schema::table('files', function (Blueprint $table): void {
            $table->unsignedBigInteger('folder_id')->nullable()->index();
        });
    }

    public function down(): void
    {
        Schema::table('files', function (Blueprint $table): void {
            $table->dropIndex(['folder_id']);
            $table->dropColumn('folder_id');
        });
        Schema::dropIfExists('upload_folders');
    }
};
`;

export const emitUploadFolderModel = (fileModel: string): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Models;

use App\\Models\\Concerns\\HasDocumentId;
use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\Relations\\BelongsTo;
use Illuminate\\Database\\Eloquent\\Relations\\HasMany;

/** A media library folder, kept and changed through StrapiFolders. */
class UploadFolder extends Model
{
    use HasDocumentId;

    protected $table = 'upload_folders';

    protected function casts(): array
    {
        return [
            'path_id' => 'integer',
            'parent_id' => 'integer',
            'published_at' => 'datetime',
        ];
    }

    public function parent(): BelongsTo
    {
        return $this->belongsTo(self::class, 'parent_id');
    }

    public function children(): HasMany
    {
        return $this->hasMany(self::class, 'parent_id');
    }

    public function files(): HasMany
    {
        return $this->hasMany(${fileModel}::class, 'folder_id');
    }
}
`;

/**
 * Strapi's folder service and its admin validation: a folder is made with the next path id under
 * its parent's path; moving one rewrites its own path, its folders' and its files' folder paths;
 * deleting one deletes every folder and file below it. Content API uploads go to "API Uploads",
 * made on first use and remembered by id, as Strapi's api-upload-folder service does.
 */
export const emitStrapiFolders = (fileModel: string): string =>
  header("App\\Support") +
  String.raw`
use ${`App\\Models\\${fileModel}`};
use App\Models\UploadFolder;
use Illuminate\Support\Facades\DB;

final class StrapiFolders
{
    /** The setting that keeps the id of the folder Content API uploads go to. */
    private const API_FOLDER = 'upload.api-folder';

    private const API_FOLDER_NAME = 'API Uploads';

    public static function create(string $name, ?int $parent): UploadFolder
    {
        self::check(null, $name, $parent);

        return DB::transaction(function () use ($name, $parent): UploadFolder {
            $folder = new UploadFolder();
            $folder->name = $name;
            $folder->parent_id = $parent;
            $folder->path_id = ((int) UploadFolder::query()->max('path_id')) + 1;
            $folder->path = self::join(self::pathOf($parent), $folder->path_id);
            $folder->published_at = now();
            $folder->save();

            return $folder;
        });
    }

    /** Renames a folder and, when its parent changes, moves it with everything below it. */
    public static function update(UploadFolder $folder, string $name, ?int $parent): UploadFolder
    {
        self::check($folder, $name, $parent);

        return DB::transaction(function () use ($folder, $name, $parent): UploadFolder {
            if ($parent !== $folder->parent_id) {
                $from = $folder->path;
                $to = self::join(self::pathOf($parent), $folder->path_id);
                // By prefix, not Strapi's REPLACE(), which also rewrites a later "/1" in "/1/11".
                foreach (self::below(UploadFolder::query(), 'path', $from)->get() as $child) {
                    $child->path = $to . substr($child->path, strlen($from));
                    $child->save();
                }
                foreach (self::below(${fileModel}::query(), 'folder_path', $from)->get(['id', 'folder_path']) as $file) {
                    ${fileModel}::query()->whereKey($file->getKey())->update(['folder_path' => $to . substr((string) $file->folder_path, strlen($from))]);
                }
                $folder->path = $to;
                $folder->parent_id = $parent;
            }
            $folder->name = $name;
            $folder->save();

            return $folder;
        });
    }

    /** Deletes a folder, the folders below it, and every file they hold with what it stores. */
    public static function delete(UploadFolder $folder): void
    {
        DB::transaction(function () use ($folder): void {
            self::below(${fileModel}::query(), 'folder_path', $folder->path, true)->get()->each->delete();
            self::below(UploadFolder::query(), 'path', $folder->path, true)->delete();
        });
    }

    /** The folder Content API uploads go to, made on first use beside any folder of its name. */
    public static function apiUploads(): UploadFolder
    {
        $id = StrapiSettings::get(self::API_FOLDER)['id'] ?? null;
        $folder = is_int($id) ? UploadFolder::query()->find($id) : null;
        if ($folder !== null) {
            return $folder;
        }
        $name = self::API_FOLDER_NAME;
        for ($index = 1; UploadFolder::query()->whereNull('parent_id')->where('name', $name)->exists(); $index++) {
            $name = self::API_FOLDER_NAME . " ({$index})";
        }
        $folder = self::create($name, null);
        StrapiSettings::merge(self::API_FOLDER, ['id' => $folder->getKey()]);

        return $folder;
    }

    /** A file's folder path: its folder's path, or the library's root. */
    public static function pathOf(?int $folder): string
    {
        return $folder === null ? '/' : UploadFolder::query()->findOrFail($folder)->path;
    }

    /**
     * Every folder by id, labelled with its ancestors ("Photos / 2024") and in path order; without
     * $except and the folders below it, where a folder could not move to.
     *
     * @return array<int, string>
     */
    public static function options(?UploadFolder $except = null): array
    {
        $folders = UploadFolder::query()->get(['id', 'name', 'path_id', 'path']);
        $names = $folders->pluck('name', 'path_id')->all();
        $options = [];
        foreach ($folders as $folder) {
            if ($except !== null && self::within($folder->path, $except->path)) {
                continue;
            }
            $ids = array_map('intval', explode('/', trim($folder->path, '/')));
            $options[$folder->getKey()] = implode(' / ', array_map(fn (int $id): string => (string) ($names[$id] ?? '?'), $ids));
        }
        asort($options, SORT_NATURAL | SORT_FLAG_CASE);

        return $options;
    }

    /** What Strapi's admin refuses about a folder's name and place, or null when it takes them. */
    public static function problem(?UploadFolder $folder, string $name, ?int $parent): ?string
    {
        return self::nameProblem($folder, $name, $parent) ?? self::parentProblem($folder, $parent);
    }

    public static function nameProblem(?UploadFolder $folder, string $name, ?int $parent): ?string
    {
        if ($name === '') {
            return 'name is a required field';
        }
        if (str_contains($name, '/')) {
            return 'name cannot contain slashes';
        }
        if (preg_match('/^(?! ).+(?<! )$/s', $name) !== 1) {
            return 'name cannot start or end with a whitespace';
        }
        $siblings = UploadFolder::query()->where('name', $name);
        $parent === null ? $siblings->whereNull('parent_id') : $siblings->where('parent_id', $parent);
        if ($folder !== null) {
            $siblings->whereKeyNot($folder->getKey());
        }

        return $siblings->exists() ? 'A folder with this name already exists' : null;
    }

    public static function parentProblem(?UploadFolder $folder, ?int $parent): ?string
    {
        if ($parent === null) {
            return null;
        }
        $destination = UploadFolder::query()->find($parent);
        if ($destination === null) {
            return 'parent folder does not exist';
        }

        return $folder !== null && self::within($destination->path, $folder->path) ? 'folder cannot be moved inside itself' : null;
    }

    private static function check(?UploadFolder $folder, string $name, ?int $parent): void
    {
        $problem = self::problem($folder, $name, $parent);
        if ($problem !== null) {
            throw StrapiError::validation($problem);
        }
    }

    private static function within(string $path, string $ancestor): bool
    {
        return $path === $ancestor || str_starts_with($path, "{$ancestor}/");
    }

    /**
     * Rows whose path is below $path (and $path itself when $inclusive). Paths hold only digits
     * and slashes, so LIKE needs no escaping.
     */
    private static function below(\Illuminate\Database\Eloquent\Builder $query, string $column, string $path, bool $inclusive = false): \Illuminate\Database\Eloquent\Builder
    {
        return $query->where(function ($where) use ($column, $path, $inclusive): void {
            $where->where($column, 'like', "{$path}/%");
            if ($inclusive) {
                $where->orWhere($column, $path);
            }
        });
    }

    private static function join(string $parentPath, int $pathId): string
    {
        return rtrim($parentPath, '/') . '/' . $pathId;
    }
}
`;

/** Folders are part of the media library, so its grants decide who may see and change them. */
export const emitUploadFolderPolicy = (fileType: string): string => {
  const can = (action: "read" | "create" | "update" | "delete"): string =>
    `return $user->can('${permissionKey(fileType, action)}');`;
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Policies;

use App\\Models\\UploadFolder;
use App\\Models\\User;

class UploadFolderPolicy
{
    public function viewAny(User $user): bool
    {
        ${can("read")}
    }

    public function view(User $user, UploadFolder $folder): bool
    {
        ${can("read")}
    }

    public function create(User $user): bool
    {
        ${can("create")}
    }

    public function update(User $user, UploadFolder $folder): bool
    {
        ${can("update")}
    }

    public function delete(User $user, UploadFolder $folder): bool
    {
        ${can("delete")}
    }
}
`;
};

/**
 * The media library's folders in the admin, under its menu item: each folder with where it is and
 * what it holds, opened as the library's file list filtered to it; made, renamed and moved with
 * Strapi's checks, and deleted with everything below it.
 */
export const emitUploadFolderResourceFiles = (
  fileModel: string,
  fileResourceDir: string,
): { path: string; content: string }[] => {
  const ns = "App\\Filament\\Resources\\UploadFolders";
  const page = (cls: string, base: string, uses: string[], body: string): string => `<?php

declare(strict_types=1);

namespace ${ns}\\Pages;

${[`${ns}\\UploadFolderResource`, `Filament\\Resources\\Pages\\${base}`, ...uses]
  .sort()
  .map((u) => `use ${u};`)
  .join("\n")}

class ${cls} extends ${base}
{
    protected static string $resource = UploadFolderResource::class;
${body}}
`;
  const parent = "filled($data['parent_id'] ?? null) ? (int) $data['parent_id'] : null";
  return [
    {
      path: "app/Filament/Resources/UploadFolders/UploadFolderResource.php",
      content: `<?php

declare(strict_types=1);

namespace ${ns};

use App\\Filament\\Resources\\${fileResourceDir}\\${fileModel}Resource;
use App\\Models\\UploadFolder;
use App\\Support\\StrapiFolders;
use BackedEnum;
use Closure;
use ${ns}\\Pages\\CreateUploadFolder;
use ${ns}\\Pages\\EditUploadFolder;
use ${ns}\\Pages\\ListUploadFolders;
use Filament\\Actions\\Action;
use Filament\\Actions\\DeleteAction;
use Filament\\Actions\\EditAction;
use Filament\\Forms\\Components\\Select;
use Filament\\Forms\\Components\\TextInput;
use Filament\\Resources\\Resource;
use Filament\\Schemas\\Components\\Utilities\\Get;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Columns\\TextColumn;
use Filament\\Tables\\Table;

class UploadFolderResource extends Resource
{
    protected static ?string $model = UploadFolder::class;

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-folder';

    protected static ?string $navigationLabel = 'Folders';

    protected static ?string $navigationParentItem = 'Media Library';

    protected static ?string $modelLabel = 'folder';

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('name')->required()->rules([
                fn (Get $get, ?UploadFolder $record): Closure => function (string $attribute, mixed $value, Closure $fail) use ($get, $record): void {
                    $problem = StrapiFolders::nameProblem($record, (string) $value, filled($get('parent_id')) ? (int) $get('parent_id') : null);
                    if ($problem !== null) {
                        $fail($problem);
                    }
                },
            ]),
            Select::make('parent_id')
                ->label('Location')
                ->placeholder('Media Library')
                ->options(fn (?UploadFolder $record): array => StrapiFolders::options($record))
                ->rules([
                    fn (?UploadFolder $record): Closure => function (string $attribute, mixed $value, Closure $fail) use ($record): void {
                        $problem = StrapiFolders::parentProblem($record, filled($value) ? (int) $value : null);
                        if ($problem !== null) {
                            $fail($problem);
                        }
                    },
                ]),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name')->searchable()->sortable(),
                TextColumn::make('location')->state(fn (UploadFolder $record): string => $record->parent_id === null ? 'Media Library' : (StrapiFolders::options()[$record->parent_id] ?? '')),
                TextColumn::make('children_count')->counts('children')->label('Folders'),
                TextColumn::make('files_count')->counts('files')->label('Files'),
                TextColumn::make('updated_at')->dateTime()->sortable(),
            ])
            ->defaultSort('path')
            ->recordActions([
                Action::make('open')
                    ->icon('heroicon-o-folder-open')
                    ->url(fn (UploadFolder $record): string => ${fileModel}Resource::getUrl('index', ['filters' => ['folder' => ['value' => $record->getKey()]]])),
                EditAction::make(),
                DeleteAction::make()
                    ->modalDescription('Deleting this folder also deletes the folders and files in it.')
                    ->using(fn (UploadFolder $record) => StrapiFolders::delete($record)),
            ]);
    }

    public static function getPages(): array
    {
        return [
            'index' => ListUploadFolders::route('/'),
            'create' => CreateUploadFolder::route('/create'),
            'edit' => EditUploadFolder::route('/{record}/edit'),
        ];
    }
}
`,
    },
    {
      path: "app/Filament/Resources/UploadFolders/Pages/ListUploadFolders.php",
      content: page(
        "ListUploadFolders",
        "ListRecords",
        ["Filament\\Actions\\CreateAction"],
        `
    protected function getHeaderActions(): array
    {
        return [
            CreateAction::make()->label('Add new folder'),
        ];
    }
`,
      ),
    },
    {
      path: "app/Filament/Resources/UploadFolders/Pages/CreateUploadFolder.php",
      content: page(
        "CreateUploadFolder",
        "CreateRecord",
        ["App\\Support\\StrapiFolders", "Illuminate\\Database\\Eloquent\\Model"],
        `
    protected function handleRecordCreation(array $data): Model
    {
        return StrapiFolders::create((string) $data['name'], ${parent});
    }
`,
      ),
    },
    {
      path: "app/Filament/Resources/UploadFolders/Pages/EditUploadFolder.php",
      content: page(
        "EditUploadFolder",
        "EditRecord",
        [
          "App\\Models\\UploadFolder",
          "App\\Support\\StrapiFolders",
          "Filament\\Actions\\DeleteAction",
          "Illuminate\\Database\\Eloquent\\Model",
        ],
        `
    protected function getHeaderActions(): array
    {
        return [
            DeleteAction::make()->using(fn (UploadFolder $record) => StrapiFolders::delete($record)),
        ];
    }

    protected function handleRecordUpdate(Model $record, array $data): Model
    {
        assert($record instanceof UploadFolder);

        return StrapiFolders::update($record, (string) $data['name'], ${parent});
    }
`,
      ),
    },
  ];
};
