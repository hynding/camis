<?php

declare(strict_types=1);

namespace App\Support;

use App\Models\UploadFolder;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * The Media Library tools of Strapi's MCP server: assets and folders by their numeric ids, with
 * Strapi's checks in Strapi's order and its words for what it refuses. An asset is shown through
 * an allowlist, so its provider metadata, hash, formats and folder path never reach a client.
 */
final class StrapiMcpMedia
{
    private const NOT_FOUND_ASSET = 'Media asset not found.';

    private const UPDATE_ASSET_NO_FIELDS = 'Provide at least one field to update: name, alternativeText or caption. To move an asset between folders use media_move_assets; url, mime, size and the file contents are owned by the upload provider and cannot be edited over MCP.';

    private const NOT_FOUND_FOLDER = 'Media folder not found.';

    private const FOLDER_NAME_TAKEN = 'A folder with this name already exists in the same parent folder. Folder names must be unique among siblings.';

    private const PARENT_FOLDER_NOT_FOUND = 'The parent folder does not exist. Use media_list_folders to discover valid folder ids, or pass null for the media library root.';

    private const FOLDER_MOVE_INTO_SELF = 'A folder cannot be moved into itself or into one of its own descendants.';

    private const MOVE_ASSETS_DESTINATION_NOT_FOUND = 'The destination folder does not exist. Use media_list_folders to discover valid folder ids, or pass null for the media library root.';

    private const MOVE_ASSETS_ID_NOT_FOUND = 'No media asset has this id, so nothing was moved for it. If this is a folder id, use media_move_folder — and note that a folder id only fails like this when no asset happens to share the number; when one does, media_move_assets moves that asset instead. Otherwise the asset may already be deleted — use media_list_assets to discover valid asset ids.';

    private const DELETE_ASSETS_ID_NOT_FOUND = 'No media asset has this id, so nothing was deleted for it. If this is a folder id, use media_delete_folder — and note that a folder id only fails like this when no asset happens to share the number; when one does, media_delete_assets deletes that asset instead. Otherwise the asset may already be deleted; use media_list_assets to discover valid asset ids.';

    /** The sorts the Media Library's admin offers, by the column each reads. */
    private const SORT_COLUMNS = ['createdAt' => 'created_at', 'updatedAt' => 'updated_at', 'name' => 'name'];

    /** @param class-string<Model> $model the project's file model */
    private function __construct(private readonly string $model)
    {
    }

    /**
     * @param  array<string, mixed>  $tool
     * @param  array<string, mixed>  $type
     * @param  array<string, mixed>  $args
     * @return array<string, mixed>
     */
    public static function call(array $tool, array $type, array $args): array
    {
        $media = new self($type['model']);

        return match ($tool['operation']) {
            'list_assets' => $media->listAssets($args),
            'get_asset' => ['data' => self::asset($media->find($args['id'] ?? 0) ?? throw new StrapiMcpError(0, self::NOT_FOUND_ASSET))],
            'list_folders' => ['data' => self::tree()],
            'update_asset' => $media->updateAsset($args),
            'move_assets' => $media->moveAssets($args),
            'delete_assets' => $media->deleteAssets($args),
            'create_folder' => self::createFolder($args),
            'rename_folder' => self::renameFolder($args),
            'move_folder' => self::moveFolder($args),
            'delete_folder' => $media->deleteFolder($args),
            default => throw new StrapiMcpError(0, "Unknown media operation {$tool['operation']}"),
        };
    }

    // ------------------------------------------------------------------------------- the assets

    /**
     * Assets in a folder (null: at the root), of a mime type (a bare type: any of its subtypes),
     * named like a word, a page at a time.
     *
     * @return array<string, mixed>
     */
    private function listAssets(array $args): array
    {
        $query = $this->query()->with('folder:id,name');
        if (array_key_exists('folderId', $args)) {
            $args['folderId'] === null ? $query->whereNull('folder_id') : $query->where('folder_id', $args['folderId']);
        }
        if (isset($args['mime'])) {
            $mime = mb_strtolower((string) $args['mime']);
            str_contains($mime, '/')
                ? $query->whereRaw('LOWER(mime) = ?', [$mime])
                : $query->whereRaw("LOWER(mime) LIKE ? ESCAPE '!'", [self::escapeLike($mime).'/%']);
        }
        if (isset($args['name'])) {
            $query->whereRaw("LOWER(name) LIKE ? ESCAPE '!'", ['%'.self::escapeLike(mb_strtolower((string) $args['name'])).'%']);
        }
        [$field, $direction] = explode(':', (string) ($args['sort'] ?? 'createdAt:DESC'));
        $query->orderBy(self::SORT_COLUMNS[$field] ?? 'created_at', strtolower($direction) === 'asc' ? 'asc' : 'desc');
        $page = (int) ($args['page'] ?? 1);
        $pageSize = (int) ($args['pageSize'] ?? 25);
        $total = (clone $query)->count();
        $rows = $query->forPage($page, $pageSize)->get();

        return [
            'results' => $rows->map(fn (Model $file): array => self::asset($file))->values()->all(),
            'pagination' => ['page' => $page, 'pageSize' => $pageSize, 'pageCount' => (int) ceil($total / $pageSize), 'total' => $total],
        ];
    }

    /**
     * Its name, alternative text and caption, as given: null clears a text, as an empty one.
     *
     * @return array<string, mixed>
     */
    private function updateAsset(array $args): array
    {
        $info = [];
        foreach (['name', 'alternativeText', 'caption'] as $key) {
            if (array_key_exists($key, $args)) {
                $info[$key] = $args[$key] === null ? '' : (string) $args[$key];
            }
        }
        if ($info === []) {
            throw new StrapiMcpError(0, self::UPDATE_ASSET_NO_FIELDS);
        }
        $file = $this->find($args['id'] ?? 0) ?? throw new StrapiMcpError(0, self::NOT_FOUND_ASSET);
        foreach (['name' => 'name', 'alternativeText' => 'alternative_text', 'caption' => 'caption'] as $key => $column) {
            if (isset($info[$key])) {
                $file->setAttribute($column, $info[$key]);
            }
        }
        $this->touched($file);

        return ['data' => self::asset($this->find($file->getKey()) ?? $file)];
    }

    /**
     * Each asset into the folder (null: the root), one at a time: what moved and what did not,
     * with why, so that a caller retries only the failures.
     *
     * @return array<string, mixed>
     */
    private function moveAssets(array $args): array
    {
        $folder = $args['folder'] ?? null;
        $destination = null;
        if ($folder !== null) {
            $found = UploadFolder::query()->find($folder) ?? throw new StrapiMcpError(0, self::MOVE_ASSETS_DESTINATION_NOT_FOUND);
            $destination = ['id' => (int) $found->getKey(), 'name' => (string) $found->name];
        }
        $moved = [];
        $failed = [];
        foreach (self::unique($args['ids'] ?? []) as $id) {
            $file = $this->find($id);
            if ($file === null) {
                $failed[] = ['id' => $id, 'reason' => self::MOVE_ASSETS_ID_NOT_FOUND];

                continue;
            }
            try {
                $file->setAttribute('folder_id', $folder);
                $this->touched($file);
                $file->unsetRelation('folder');
                $moved[] = [...self::asset($file), 'folder' => $destination];
            } catch (Throwable $error) {
                $failed[] = ['id' => $id, 'reason' => "Moving this asset failed: {$error->getMessage()}. This is not a problem with the id itself — the asset exists and this token may edit it — so retrying may succeed. Any assets listed under `moved` were still moved."];
            }
        }

        return ['destinationFolder' => $destination, 'moved' => $moved, 'failed' => $failed];
    }

    /**
     * The assets a deletion takes, and, unless it is a dry run (the default), takes them with what
     * they store.
     *
     * @return array<string, mixed>
     */
    private function deleteAssets(array $args): array
    {
        $dryRun = ($args['dryRun'] ?? true) !== false;
        $deleted = [];
        $failed = [];
        foreach (self::unique($args['ids'] ?? []) as $id) {
            $file = $this->find($id);
            if ($file === null) {
                $failed[] = ['id' => $id, 'reason' => self::DELETE_ASSETS_ID_NOT_FOUND];

                continue;
            }
            $shown = self::asset($file);
            if (! $dryRun) {
                try {
                    DB::transaction(fn () => $file->delete());
                } catch (Throwable $error) {
                    $failed[] = ['id' => $id, 'reason' => "Deleting this asset failed: {$error->getMessage()}. The asset may be partially removed — re-read it with media_get_asset before retrying. Any assets listed under `deleted` are gone for good."];

                    continue;
                }
            }
            $deleted[] = $shown;
        }

        return ['dryRun' => $dryRun, 'deleted' => $deleted, 'failed' => $failed, 'totalFileNumber' => count($deleted)];
    }

    private function find(mixed $id): ?Model
    {
        return is_int($id) || is_string($id) ? $this->query()->with('folder:id,name')->find($id) : null;
    }

    /** Strapi's update writes the row, so it is updated even when nothing in it changed. */
    private function touched(Model $file): void
    {
        $file->setAttribute('updated_at', now());
        $file->save();
    }

    /** @return Builder<Model> */
    private function query(): Builder
    {
        return ($this->model)::query();
    }

    /** @return array<string, mixed> an asset as the tools show it */
    private static function asset(Model $file): array
    {
        $folder = $file->getRelationValue('folder');

        return [
            'id' => (int) $file->getKey(),
            'name' => (string) $file->getAttribute('name'),
            'alternativeText' => self::text($file->getAttribute('alternative_text')),
            'caption' => self::text($file->getAttribute('caption')),
            'url' => (string) $file->getAttribute('url'),
            'mime' => (string) $file->getAttribute('mime'),
            'size' => self::number($file->getAttribute('size')) ?? 0,
            'width' => self::number($file->getAttribute('width')),
            'height' => self::number($file->getAttribute('height')),
            'ext' => self::text($file->getAttribute('ext')),
            'folder' => $folder instanceof Model ? ['id' => (int) $folder->getKey(), 'name' => (string) $folder->getAttribute('name')] : null,
            'createdAt' => self::time($file->getAttribute('created_at')),
            'updatedAt' => self::time($file->getAttribute('updated_at')),
        ];
    }

    // ------------------------------------------------------------------------------ the folders

    /**
     * Every folder below its parent, roots first, siblings by name.
     *
     * @return list<array{id: int, name: string, children: list<mixed>}>
     */
    private static function tree(): array
    {
        $children = [];
        foreach (UploadFolder::query()->orderBy('id')->get(['id', 'name', 'parent_id']) as $folder) {
            $children[$folder->parent_id === null ? 'root' : (string) $folder->parent_id][] = $folder;
        }
        $nodes = function (string $key) use (&$nodes, $children): array {
            $list = array_map(fn (UploadFolder $folder): array => [
                'id' => (int) $folder->getKey(),
                'name' => (string) $folder->name,
                'children' => $nodes((string) $folder->getKey()),
            ], $children[$key] ?? []);
            usort($list, fn (array $a, array $b): int => strcmp($a['name'], $b['name']));

            return $list;
        };

        return $nodes('root');
    }

    /** @return array<string, mixed> */
    private static function createFolder(array $args): array
    {
        $name = (string) $args['name'];
        $parent = self::id($args['parent'] ?? null);
        self::parentExists($parent);
        self::nameAvailable($name, $parent, null);

        return ['data' => self::folder(StrapiFolders::create($name, $parent))];
    }

    /** @return array<string, mixed> */
    private static function renameFolder(array $args): array
    {
        $folder = self::existingFolder($args['id'] ?? 0);
        $name = (string) $args['name'];
        self::nameAvailable($name, $folder->parent_id, (int) $folder->getKey());

        return ['data' => self::folder(StrapiFolders::update($folder, $name, $folder->parent_id))];
    }

    /** @return array<string, mixed> */
    private static function moveFolder(array $args): array
    {
        $folder = self::existingFolder($args['id'] ?? 0);
        $parent = self::id($args['parent'] ?? null);
        self::parentExists($parent);
        $destination = $parent === null ? null : UploadFolder::query()->find($parent);
        if ($destination !== null && self::within((string) $destination->path, (string) $folder->path)) {
            throw new StrapiMcpError(0, self::FOLDER_MOVE_INTO_SELF);
        }
        // A folder keeps its name across a move, so it must be free among its new siblings.
        self::nameAvailable((string) $folder->name, $parent, (int) $folder->getKey());

        return ['data' => self::folder(StrapiFolders::update($folder, (string) $folder->name, $parent))];
    }

    /**
     * The folders, the folders below them and the files they hold, counted, and deleted unless
     * it is a dry run (the default). Every id must name a folder, or nothing is.
     *
     * @return array<string, mixed>
     */
    private function deleteFolder(array $args): array
    {
        $ids = array_map(fn (mixed $id): int => (int) $id, $args['ids'] ?? []);
        $dryRun = ($args['dryRun'] ?? true) !== false;
        $matched = UploadFolder::query()->whereKey($ids)->orderBy('id')->get();
        $found = $matched->map(fn (UploadFolder $folder): int => (int) $folder->getKey())->all();
        $unresolved = array_values(array_filter($ids, fn (int $id): bool => ! in_array($id, $found, true)));
        if ($unresolved !== []) {
            throw new StrapiMcpError(0, 'These ids do not match any media folder: '.implode(', ', $unresolved).'. Nothing was deleted — media_delete_folder rejects the whole request rather than deleting the folders that did match, because folder ids and asset ids are indistinguishable integers. If these are asset ids, use media_delete_assets instead; otherwise the folders may already be gone. Use media_list_folders to discover valid folder ids.');
        }
        $paths = $matched->map(fn (UploadFolder $folder): string => (string) $folder->path)->all();
        $below = function (Builder $query, string $column) use ($paths): Builder {
            return $query->where(function (Builder $where) use ($column, $paths): void {
                foreach ($paths as $path) {
                    $where->orWhere($column, $path)->orWhere($column, 'like', "{$path}/%");
                }
            });
        };
        $counts = [
            'totalFolderNumber' => $below(UploadFolder::query(), 'path')->count(),
            'totalFileNumber' => $below($this->query(), 'folder_path')->count(),
        ];
        // The rows were read with only these columns: Strapi shows neither parent nor times.
        $folders = $matched->map(fn (UploadFolder $folder): array => ['id' => (int) $folder->getKey(), 'name' => (string) $folder->name, 'createdAt' => null, 'updatedAt' => null])->all();
        if (! $dryRun) {
            foreach ($matched as $folder) {
                if (UploadFolder::query()->whereKey($folder->getKey())->exists()) {
                    StrapiFolders::delete($folder);
                }
            }
        }

        return ['dryRun' => $dryRun, 'folders' => $folders, ...$counts];
    }

    private static function existingFolder(mixed $id): UploadFolder
    {
        return UploadFolder::query()->find(self::id($id)) ?? throw new StrapiMcpError(0, self::NOT_FOUND_FOLDER);
    }

    private static function parentExists(?int $parent): void
    {
        if ($parent !== null && ! UploadFolder::query()->whereKey($parent)->exists()) {
            throw new StrapiMcpError(0, self::PARENT_FOLDER_NOT_FOUND);
        }
    }

    private static function nameAvailable(string $name, ?int $parent, ?int $except): void
    {
        $siblings = UploadFolder::query()->where('name', $name);
        $parent === null ? $siblings->whereNull('parent_id') : $siblings->where('parent_id', $parent);
        if ($except !== null) {
            $siblings->whereKeyNot($except);
        }
        if ($siblings->exists()) {
            throw new StrapiMcpError(0, self::FOLDER_NAME_TAKEN);
        }
    }

    /** @return array<string, mixed> a folder as the write tools show it, with its parent */
    private static function folder(UploadFolder $folder): array
    {
        $folder = UploadFolder::query()->with('parent:id,name')->find($folder->getKey()) ?? $folder;
        $parent = $folder->getRelationValue('parent');

        return [
            'id' => (int) $folder->getKey(),
            'name' => (string) $folder->name,
            'parent' => $parent instanceof UploadFolder ? ['id' => (int) $parent->getKey(), 'name' => (string) $parent->name] : null,
            'createdAt' => self::time($folder->getAttribute('created_at')),
            'updatedAt' => self::time($folder->getAttribute('updated_at')),
        ];
    }

    private static function within(string $path, string $ancestor): bool
    {
        return $path === $ancestor || str_starts_with($path, "{$ancestor}/");
    }

    // ---------------------------------------------------------------------------------- values

    /** @return list<mixed> the ids once each, in the order first given */
    private static function unique(mixed $ids): array
    {
        return is_array($ids) ? array_values(array_unique($ids, SORT_REGULAR)) : [];
    }

    private static function id(mixed $id): ?int
    {
        return is_int($id) || is_numeric($id) ? (int) $id : null;
    }

    private static function text(mixed $value): ?string
    {
        return $value === null ? null : (is_scalar($value) ? (string) $value : (string) json_encode($value));
    }

    /** A whole number as an integer, as JavaScript writes one. */
    private static function number(mixed $value): int|float|null
    {
        if (! is_numeric($value)) {
            return null;
        }
        $number = $value + 0;

        return is_float($number) && floor($number) === $number && abs($number) < PHP_INT_MAX ? (int) $number : $number;
    }

    private static function time(mixed $value): ?string
    {
        return $value instanceof \DateTimeInterface ? \Illuminate\Support\Carbon::instance($value)->toIso8601ZuluString('millisecond') : null;
    }

    private static function escapeLike(string $value): string
    {
        return str_replace(['!', '%', '_'], ['!!', '!%', '!_'], $value);
    }
}
