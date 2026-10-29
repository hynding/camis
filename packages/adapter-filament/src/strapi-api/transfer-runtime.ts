import { PHP_MARKER } from "../hooks/names";

/**
 * Strapi's data import, restore strategy: an archive `strapi export` wrote (`.tar`, `.tar.gz`,
 * `.tar.gz.enc`)
 * replaces this app's content, files and configuration. Everything `StrapiTransferMap` names is
 * deleted, then every archived entry is inserted with its documentId and timestamps, then its
 * links, then the files' bytes. Ids are this database's own: links are resolved through the map
 * of archived id → new row id the inserts build. A row of a type without draft and publish keeps
 * its links to a draft-and-publish document's draft only, as camis stores them. Users are matched by email
 * rather than deleted, since the same table holds the admin's accounts. The canonical check is
 * `transfer/read-vectors.json`, recorded from strapi-php after it imported the same archive.
 */
export const emitStrapiImport = (): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n` +
  String.raw`
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasOneOrMany;
use Illuminate\Database\Eloquent\Relations\MorphToMany;
use Illuminate\Support\Facades\DB;
use Spatie\Permission\Models\Role;

final class StrapiImport
{
    public const STAGES = ['content', 'files', 'config'];

    /** Keys every Strapi schema carries that are not the content type's own attributes. */
    private const SYSTEM = ['documentId', 'createdAt', 'updatedAt', 'publishedAt', 'createdBy', 'updatedBy', 'locale', 'localizations'];

    /** core-store keys this app keeps, and the setting each is kept under. */
    private const SETTINGS = [
        'plugin_users-permissions_advanced' => 'users-permissions.advanced',
        'plugin_users-permissions_email' => 'users-permissions.email',
        'plugin_users-permissions_grant' => 'users-permissions.grant',
    ];

    private const FOLDER = 'plugin::upload.folder';

    /** Where Strapi's core store keeps the folder Content API uploads go to, and where this app does. */
    private const API_FOLDER = ['plugin_upload_api-folder', 'upload.api-folder'];

    private const FILE_COLUMNS = [
        'documentId' => 'document_id', 'name' => 'name', 'alternativeText' => 'alternative_text', 'caption' => 'caption',
        'focalPoint' => 'focal_point', 'width' => 'width', 'height' => 'height', 'formats' => 'formats', 'hash' => 'hash',
        'ext' => 'ext', 'mime' => 'mime', 'size' => 'size', 'url' => 'url', 'previewUrl' => 'preview_url', 'provider' => 'provider',
        'provider_metadata' => 'provider_metadata', 'folderPath' => 'folder_path', 'createdAt' => 'created_at',
        'updatedAt' => 'updated_at', 'publishedAt' => 'published_at',
    ];

    /** @var array<string, array<int|string, int>> uid → archived id → row id */
    private array $rows = [];

    /** @var array<string, array<int|string, bool>> uid → archived id → whether the entry is a draft */
    private array $drafts = [];

    /** @var array<string, array<int|string, array<string, array{0: string, 1: int|string}>>> uid → archived id → foreign key → [target uid, archived id] */
    private array $foreign = [];

    /** @var array<string, array<int|string, array<string, int|float|null>>> uid → archived id → order column → the link's archived position */
    private array $orders = [];

    /** @var list<array{0: string, 1: string, 2: int, 3: string, 4: int|string, 5: string}> keys set once every row exists */
    private array $pending = [];

    /** @var array<int|string, string> archived role id → role type */
    private array $roles = [];

    /** @var array<string, int> */
    private array $counts = [];

    /** @var array<string, string> uid or key → why it was not imported */
    private array $skipped = [];

    /** @var list<string> files the deleted rows pointed at */
    private array $obsolete = [];

    /** @param array<string, string> $entries the archive's files: path → bytes */
    private function __construct(private readonly array $entries)
    {
        if (! isset($entries['metadata.json'])) {
            throw new \RuntimeException('Not a Strapi export archive: it has no metadata.json');
        }
    }

    public static function open(string $path, ?string $key = null): self
    {
        $bytes = is_file($path) ? file_get_contents($path) : false;
        if ($bytes === false) {
            throw new \RuntimeException("Cannot read {$path}");
        }
        if (str_ends_with($path, '.enc') || ($key !== null && ! str_starts_with($bytes, "\x1f\x8b"))) {
            if ($key === null) {
                throw new \RuntimeException('The archive is encrypted: pass its key with --key');
            }
            $bytes = StrapiTransferCipher::decrypt($bytes, $key);
        }
        if (str_starts_with($bytes, "\x1f\x8b")) {
            $bytes = gzdecode($bytes);
            if ($bytes === false) {
                throw new \RuntimeException("{$path} is not a valid gzip file");
            }
        }

        return new self(self::untar($bytes));
    }

    /**
     * Strapi's --only and --exclude, over its three data types.
     *
     * @param list<string>|null $only
     * @param list<string>|null $exclude
     * @return list<string>
     */
    public static function stages(?array $only, ?array $exclude): array
    {
        if ($only !== null && $exclude !== null) {
            throw new \InvalidArgumentException('--only and --exclude cannot both be used');
        }
        foreach ([...($only ?? []), ...($exclude ?? [])] as $type) {
            if (! in_array($type, self::STAGES, true)) {
                throw new \InvalidArgumentException("Invalid data type \"{$type}\": the available types are content, files, config");
            }
        }

        return array_values(array_filter(self::STAGES, fn (string $s): bool => ($only === null || in_array($s, $only, true)) && ! in_array($s, $exclude ?? [], true)));
    }

    /**
     * What of the archive has nowhere to go here: a content type, or an attribute, this app does
     * not have, that the archive holds data for. A type or attribute this app has and the archive
     * lacks is fine; it stays empty. So is one this app lacks while no entity holds a value for it
     * and no link uses it, and an inverse relation, whose links Strapi exports from the owning side.
     *
     * @return list<string>
     */
    public function schemaDiffs(): array
    {
        $held = $this->heldData();
        $diffs = [];
        foreach ($this->lines('schemas') as $schema) {
            $uid = (string) ($schema['uid'] ?? '');
            if (! str_starts_with($uid, 'api::')) {
                continue;
            }
            $type = StrapiTransferMap::TYPES[$uid] ?? null;
            if ($type === null) {
                if (isset($held[$uid])) {
                    $diffs[] = "{$uid} is in the archive but not in this project";
                }

                continue;
            }
            $ours = [...array_keys($type['attributes']), ...array_keys($type['links'])];
            $owned = array_filter((array) ($schema['attributes'] ?? []), fn (mixed $a): bool => ! isset($a['mappedBy']) && ! isset($a['morphBy']));
            foreach (array_diff(array_keys($owned), self::SYSTEM, $ours) as $attribute) {
                if (isset($held[$uid][$attribute])) {
                    $diffs[] = "{$uid}.{$attribute} is in the archive but not in this project";
                }
            }
        }

        return $diffs;
    }

    /**
     * The types the archive holds entities or links of, and the attributes it holds a value or a
     * link for: uid → attribute → true (a type with no attribute in use is an empty list).
     *
     * @return array<string, array<string, true>>
     */
    private function heldData(): array
    {
        $held = [];
        foreach ($this->lines('entities') as $entity) {
            $uid = (string) ($entity['type'] ?? '');
            $held[$uid] ??= [];
            foreach ((array) ($entity['data'] ?? []) as $attribute => $value) {
                if ($value !== null && $value !== []) {
                    $held[$uid][(string) $attribute] = true;
                }
            }
        }
        foreach ($this->lines('links') as $link) {
            foreach (['left', 'right'] as $side) {
                $uid = (string) ($link[$side]['type'] ?? '');
                $held[$uid] ??= [];
                if (isset($link[$side]['field'])) {
                    $held[$uid][(string) $link[$side]['field']] = true;
                }
            }
        }

        return $held;
    }

    /**
     * @param list<string> $stages
     * @return array<string, int> imported, by type
     */
    public function run(array $stages): array
    {
        DB::transaction(function () use ($stages): void {
            if (in_array('content', $stages, true)) {
                $this->deleteContent();
                $this->content();
            }
            if (in_array('config', $stages, true)) {
                $this->configuration();
            }
        });
        if (in_array('files', $stages, true)) {
            $this->assets();
        }
        ksort($this->counts);

        return $this->counts;
    }

    /** @return array<string, string> */
    public function skipped(): array
    {
        ksort($this->skipped);

        return $this->skipped;
    }

    /** @return array<string, string> */
    private static function untar(string $tar): array
    {
        $entries = [];
        $longName = null;
        for ($offset = 0; $offset + 512 <= strlen($tar);) {
            $header = substr($tar, $offset, 512);
            if (trim($header, "\0") === '') {
                break;
            }
            $size = (int) octdec(trim(substr($header, 124, 12), "\0 "));
            $type = $header[156];
            $data = substr($tar, $offset + 512, $size);
            $offset += 512 + (int) ceil($size / 512) * 512;
            if ($type === 'L') {
                $longName = rtrim($data, "\0");
            } elseif ($type === 'x') {
                $longName = preg_match('/^\d+ path=(.*)$/m', $data, $match) === 1 ? $match[1] : $longName;
            } elseif ($type === '0' || $type === "\0") {
                $name = rtrim(substr($header, 0, 100), "\0");
                $prefix = rtrim(substr($header, 345, 155), "\0");
                $path = $longName ?? ($prefix === '' ? $name : "{$prefix}/{$name}");
                $entries[preg_replace('#^\./#', '', $path)] = $data;
                $longName = null;
            }
        }

        return $entries;
    }

    /** @return list<array<string, mixed>> the records of one stage's jsonl files, in order */
    private function lines(string $stage): array
    {
        $paths = array_values(array_filter(array_keys($this->entries), fn (string $p): bool => str_starts_with($p, "{$stage}/") && str_ends_with($p, '.jsonl')));
        sort($paths);
        $records = [];
        foreach ($paths as $path) {
            foreach (preg_split('/\r?\n/', $this->entries[$path]) ?: [] as $line) {
                if (trim($line) !== '') {
                    $records[] = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
                }
            }
        }

        return $records;
    }

    private function deleteContent(): void
    {
        $pivots = [];
        $nullable = [];
        $tables = [];
        foreach (StrapiTransferMap::TYPES as $type) {
            if (! isset($type['attributes'])) {
                continue;
            }
            $model = new ($type['model'])();
            foreach ($type['links'] as $link) {
                if ($link['kind'] === 'media') {
                    continue;
                }
                $relation = $model->{$link['relation']}();
                if ($relation instanceof BelongsToMany) {
                    $pivots[$relation->getTable()] = true;
                } elseif ($relation instanceof BelongsTo && ! $link['required']) {
                    $nullable[$model->getTable()][] = $relation->getForeignKeyName();
                }
            }
            $children = [];
            foreach ($type['attributes'] as $attribute) {
                foreach (self::childRelations($attribute) as $name) {
                    $children[] = $model->{$name}()->getRelated()->getTable();
                }
            }
            // Children before their parent; types in reverse insert order, owners before targets.
            array_unshift($tables, ...$children, ...[$model->getTable()]);
        }
        foreach (array_keys($pivots) as $pivot) {
            DB::table($pivot)->delete();
        }
        $file = StrapiTransferMap::TYPES['plugin::upload.file']['model'] ?? null;
        if ($file !== null) {
            DB::table('files_related_mph')->delete();
            $files = (new $file())->getTable();
            foreach (DB::table($files)->get(['url', 'formats']) as $row) {
                $this->obsolete[] = basename((string) $row->url);
                foreach ((array) json_decode((string) ($row->formats ?? 'null'), true) as $format) {
                    $this->obsolete[] = basename((string) ($format['url'] ?? ''));
                }
            }
            DB::table($files)->delete();
            $folder = StrapiTransferMap::TYPES[self::FOLDER]['model'] ?? null;
            if ($folder !== null) {
                DB::table((new $folder())->getTable())->delete();
            }
        }
        foreach ($nullable as $table => $columns) {
            DB::table($table)->update(array_fill_keys(array_unique($columns), null));
        }
        foreach (array_unique($tables) as $table) {
            DB::table($table)->delete();
        }
        $locale = StrapiTransferMap::TYPES['plugin::i18n.locale']['model'] ?? null;
        if ($locale !== null) {
            DB::table((new $locale())->getTable())->delete();
        }
    }

    /**
     * @param array<string, mixed>|null $attribute
     * @return list<string>
     */
    private static function childRelations(?array $attribute): array
    {
        if (isset($attribute['repeatable'])) {
            return [$attribute['repeatable']];
        }
        if (isset($attribute['component'])) {
            return array_map(fn (array $child): string => $child['repeatable'], $attribute['children'] ?? []);
        }

        return isset($attribute['zone']) ? array_values(array_map(fn (array $m): string => $m['relation'], $attribute['zone'])) : [];
    }

    private function content(): void
    {
        $entities = $this->lines('entities');
        foreach ($entities as $entity) {
            $type = StrapiTransferMap::TYPES[$entity['type']] ?? null;
            if (($type['draftPublish'] ?? false) === true) {
                $this->drafts[$entity['type']][$entity['id']] = ($entity['data']['publishedAt'] ?? null) === null;
            }
        }
        $links = array_values(array_filter($this->lines('links'), fn (array $l): bool => ($l['kind'] ?? '') !== 'relation.circular'));
        $this->foreignKeys($links);
        $byType = [];
        foreach ($entities as $entity) {
            $byType[$entity['type']][] = $entity;
        }
        foreach (array_diff(array_keys($byType), array_keys(StrapiTransferMap::TYPES)) as $uid) {
            $this->skipped[$uid] = 'this project has no such type';
        }
        foreach (StrapiTransferMap::TYPES as $uid => $type) {
            if (isset($type['skip'])) {
                if (isset($byType[$uid])) {
                    $this->skipped[$uid] = $type['skip'];
                }

                continue;
            }
            foreach ($byType[$uid] ?? [] as $entity) {
                match ($type['plugin'] ?? null) {
                    'user' => $this->user($entity['id'], $entity['data']),
                    'role' => $this->roles[$entity['id']] = (string) ($entity['data']['type'] ?? ''),
                    'file' => $this->file($type, $entity['id'], $entity['data']),
                    'folder' => $this->folder($type, $entity['id'], $entity['data']),
                    'locale' => $this->locale($type, $entity['id'], $entity['data']),
                    default => $this->entry($uid, $type, $entity['id'], $entity['data']),
                };
                $this->counts[$uid] = ($this->counts[$uid] ?? 0) + 1;
            }
        }
        foreach ($this->pending as [$table, $column, $id, $targetUid, $targetRef, $uid]) {
            $target = $this->rows[$targetUid][$targetRef] ?? null;
            if ($target === null) {
                throw new \RuntimeException("{$uid} {$column}: the entry it links to is not in the archive");
            }
            DB::table($table)->where('id', $id)->update([$column => $target]);
        }
        $this->links($links);
        $this->compareRoles($entities, $links);
    }

    /**
     * Roles are the IR's, so an archive's permissions are not imported: a role this app lacks, and
     * the Content API actions a role is granted on one side only (on the types both have), are
     * reported instead.
     *
     * @param list<array<string, mixed>> $entities
     * @param list<array<string, mixed>> $links
     */
    private function compareRoles(array $entities, array $links): void
    {
        $actions = [];
        $types = [];
        foreach ($entities as $entity) {
            if ($entity['type'] === 'plugin::users-permissions.permission') {
                $actions[$entity['id']] = (string) ($entity['data']['action'] ?? '');
            } elseif ($entity['type'] === 'plugin::users-permissions.role') {
                $types[$entity['id']] = (string) ($entity['data']['type'] ?? '');
            }
        }
        $archived = array_fill_keys(array_values($types), []);
        foreach ($links as $link) {
            if ($link['left']['type'] === 'plugin::users-permissions.permission' && isset($actions[$link['left']['ref']], $types[$link['right']['ref']])) {
                $archived[$types[$link['right']['ref']]][] = $actions[$link['left']['ref']];
            }
        }
        if (! class_exists(Role::class)) {
            return;
        }
        $mapped = array_merge(...array_values(StrapiTransferMap::ACTIONS));
        // A type only this app has is not the archive's to grant.
        $archivedTypes = array_column($this->lines('schemas'), 'uid');
        $shared = fn (string $action): bool => str_starts_with($action, 'plugin::') || in_array(substr($action, 0, (int) strrpos($action, '.')), $archivedTypes, true);
        foreach ($archived as $type => $granted) {
            $role = Role::query()->where('name', $type)->first();
            if ($role === null) {
                $this->skipped["role {$type}"] ??= "this project has no such role; roles are the IR's, and 'camis import strapi <project> --roles-from <archive>' brings an export's in";

                continue;
            }
            $ours = array_merge(...array_map(fn (string $permission): array => StrapiTransferMap::ACTIONS[$permission] ?? [], $role->permissions->pluck('name')->all()));
            $theirs = array_values(array_intersect(array_unique($granted), $mapped));
            $only = array_values(array_unique(array_diff($theirs, $ours)));
            $missing = array_values(array_unique(array_diff(array_filter($ours, $shared), $theirs)));
            sort($only);
            sort($missing);
            $differences = [
                ...($only === [] ? [] : ['the archive also grants ' . implode(', ', $only)]),
                ...($missing === [] ? [] : ['this project also grants ' . implode(', ', $missing)]),
            ];
            if ($differences !== []) {
                $this->skipped["role {$type}'s permissions"] = implode('; ', $differences) . ". Roles are the IR's: change them there and rebuild";
            }
        }
    }

    /**
     * Foreign keys are set when a row is inserted, so a required one never waits: for each
     * archived entry, which of its columns point at which archived entry.
     *
     * @param list<array<string, mixed>> $links
     */
    private function foreignKeys(array $links): void
    {
        foreach ($links as $link) {
            if (($link['kind'] ?? '') !== 'relation.basic') {
                continue;
            }
            [$left, $right] = [$link['left'], $link['right']];
            $descriptor = StrapiTransferMap::TYPES[$left['type']]['links'][$left['field']] ?? null;
            if ($descriptor === null) {
                continue;
            }
            $model = new (StrapiTransferMap::TYPES[$left['type']]['model'])();
            $relation = $model->{$descriptor['relation']}();
            if ($relation instanceof BelongsTo && $this->keeps($left['type'], $right['type'], $right['ref'])) {
                $this->foreign[$left['type']][$left['ref']][$relation->getForeignKeyName()] = [$right['type'], $right['ref']];
                // The row's place in the target's list, beside its foreign key.
                if ($descriptor['inverseOrder'] !== null) {
                    $this->orders[$left['type']][$left['ref']][$descriptor['inverseOrder']] = $right['pos'] ?? null;
                }
            } elseif ($relation instanceof HasOneOrMany && $this->keeps($right['type'], $left['type'], $left['ref'])) {
                $this->foreign[$right['type']][$right['ref']][$relation->getForeignKeyName()] = [$left['type'], $left['ref']];
                if ($descriptor['order'] !== null) {
                    $this->orders[$right['type']][$right['ref']][$descriptor['order']] = $left['pos'] ?? null;
                }
            }
        }
    }

    /**
     * A row of a type without draft and publish links a draft-and-publish document through its
     * draft only, as camis stores it; a version of a draft-and-publish row holds its own links.
     */
    private function keeps(string $holderUid, string $otherUid, int|string $otherRef): bool
    {
        if (isset($this->drafts[$holderUid]) || ! isset($this->drafts[$otherUid])) {
            return true;
        }

        return $this->drafts[$otherUid][$otherRef] ?? false;
    }

    /**
     * @param array<string, mixed> $type
     * @param array<string, mixed> $data
     */
    private function entry(string $uid, array $type, int|string $ref, array $data): void
    {
        $model = new ($type['model'])();
        $row = [];
        $children = [];
        foreach ($data as $key => $value) {
            if (! array_key_exists($key, $type['attributes'])) {
                throw new \RuntimeException("{$uid}.{$key} has nowhere to go in this project");
            }
            $attribute = $type['attributes'][$key];
            if ($attribute === null) {
                continue;
            }
            if (isset($attribute['column'])) {
                $row[$attribute['column']] = self::value($value, $attribute['type']);
            } elseif (isset($attribute['component'])) {
                foreach ($attribute['component'] as $scalar) {
                    $row[$scalar['column']] = self::value(is_array($value) ? self::at($value, $scalar['key']) : null, $scalar['type']);
                }
                foreach ($attribute['children'] ?? [] as $child) {
                    $children[$key . '.' . implode('.', $child['key'])] = [$child, is_array($value) ? self::at($value, $child['key']) : null];
                }
            } else {
                $children[$key] = [$attribute, $value];
            }
        }
        $table = $model->getTable();
        $later = [];
        foreach ($this->foreign[$uid][$ref] ?? [] as $column => [$targetUid, $targetRef]) {
            $target = $this->rows[$targetUid][$targetRef] ?? null;
            if ($target !== null) {
                $row[$column] = $target;
            } else {
                $later[] = $column;
            }
        }
        $row = [...$row, ...($this->orders[$uid][$ref] ?? [])];
        $id = (int) DB::table($table)->insertGetId($row);
        $this->rows[$uid][$ref] = $id;
        foreach ($later as $column) {
            [$targetUid, $targetRef] = $this->foreign[$uid][$ref][$column];
            $this->pending[] = [$table, $column, $id, $targetUid, $targetRef, $uid];
        }
        $model->setAttribute($model->getKeyName(), $id);
        $stamps = ['created_at' => $row['created_at'] ?? null, 'updated_at' => $row['updated_at'] ?? null];
        foreach ($children as [$attribute, $items]) {
            $position = 0;
            foreach (is_array($items) ? array_values($items) : [] as $item) {
                if (isset($attribute['repeatable'])) {
                    $this->child($model->{$attribute['repeatable']}(), $attribute['scalars'], $item, $stamps);

                    continue;
                }
                $member = $attribute['zone'][$item['__component'] ?? ''] ?? null;
                if ($member === null) {
                    throw new \RuntimeException("{$uid}: this project's zone has no component " . ($item['__component'] ?? '?'));
                }
                $this->child($model->{$member['relation']}(), $member['scalars'], $item, $stamps + ['position' => $position]);
                $position++;
            }
        }
    }

    /**
     * @param list<array{key: list<string>, column: string, type: string}> $scalars
     * @param array<string, mixed> $item
     * @param array<string, mixed> $extra
     */
    private function child(HasOneOrMany $relation, array $scalars, array $item, array $extra): void
    {
        $row = [$relation->getForeignKeyName() => $relation->getParentKey()] + $extra;
        foreach ($scalars as $scalar) {
            $row[$scalar['column']] = self::value(self::at($item, $scalar['key']), $scalar['type']);
        }
        DB::table($relation->getRelated()->getTable())->insert($row);
    }

    /** @param array<string, mixed> $data */
    private function user(int|string $ref, array $data): void
    {
        $email = mb_strtolower((string) ($data['email'] ?? ''));
        $values = [
            'name' => (string) ($data['username'] ?? $email),
            'username' => $data['username'] ?? null,
            'email' => $email,
            'password' => $data['password'] ?? null,
            'provider' => $data['provider'] ?? 'local',
            'reset_password_token' => $data['resetPasswordToken'] ?? null,
            'confirmation_token' => $data['confirmationToken'] ?? null,
            'confirmed' => (bool) ($data['confirmed'] ?? false),
            'blocked' => (bool) ($data['blocked'] ?? false),
            'document_id' => $data['documentId'] ?? null,
            'created_at' => self::value($data['createdAt'] ?? null, 'dateTime'),
            'updated_at' => self::value($data['updatedAt'] ?? null, 'dateTime'),
        ];
        $table = (new User())->getTable();
        $id = DB::table($table)->where('email', $email)->value('id');
        if ($id === null) {
            $id = DB::table($table)->insertGetId($values);
        } else {
            DB::table($table)->where('id', $id)->update($values);
        }
        $this->rows['plugin::users-permissions.user'][$ref] = (int) $id;
    }

    /**
     * @param array<string, mixed> $type
     * @param array<string, mixed> $data
     */
    private function file(array $type, int|string $ref, array $data): void
    {
        $disk = StrapiUpload::disk();
        $local = str_starts_with((string) ($data['url'] ?? ''), '/');
        if ($local && is_array($data['formats'] ?? null)) {
            foreach ($data['formats'] as $name => $format) {
                $data['formats'][$name]['url'] = $disk->url(basename((string) ($format['url'] ?? '')));
            }
        }
        if ($local) {
            // A file the local provider kept is served from this app's upload disk, wherever it is.
            $data['url'] = $disk->url(basename((string) $data['url']));
            $data['provider'] = (string) (config('camis.upload.provider') ?? (config('camis.upload.disk') ?? 'local'));
        }
        $row = [];
        foreach (self::FILE_COLUMNS as $key => $column) {
            $value = $data[$key] ?? null;
            $row[$column] = match ($key) {
                'focalPoint', 'formats', 'provider_metadata' => self::value($value, 'json'),
                'createdAt', 'updatedAt', 'publishedAt' => self::value($value, 'dateTime'),
                default => $value,
            };
        }
        $row['folder_path'] ??= '/';
        $this->rows['plugin::upload.file'][$ref] = (int) DB::table((new ($type['model'])())->getTable())->insertGetId($row);
    }

    /**
     * A media library folder; its parent, and the files in it, come with the links.
     *
     * @param array<string, mixed> $type
     * @param array<string, mixed> $data
     */
    private function folder(array $type, int|string $ref, array $data): void
    {
        $this->rows[self::FOLDER][$ref] = (int) DB::table((new ($type['model'])())->getTable())->insertGetId([
            'document_id' => $data['documentId'] ?? null,
            'name' => $data['name'],
            'path_id' => $data['pathId'],
            'path' => $data['path'],
            'created_at' => self::value($data['createdAt'] ?? null, 'dateTime'),
            'updated_at' => self::value($data['updatedAt'] ?? null, 'dateTime'),
            'published_at' => self::value($data['publishedAt'] ?? null, 'dateTime'),
        ]);
    }

    /**
     * A file's folder, or a folder's parent: a key on the row, as this app keeps them. Paths came
     * with the rows.
     *
     * @param array<string, mixed> $left
     * @param array<string, mixed> $right
     */
    private function folderLink(array $left, array $right): void
    {
        $column = ['plugin::upload.file|folder' => 'folder_id', self::FOLDER . '|parent' => 'parent_id'][$left['type'] . '|' . $left['field']] ?? null;
        $owner = $this->rows[$left['type']][$left['ref']] ?? null;
        $target = $this->rows[$right['type']][$right['ref']] ?? null;
        if ($column === null || $owner === null || $target === null) {
            return;
        }
        $model = StrapiTransferMap::TYPES[$left['type']]['model'];
        DB::table((new $model())->getTable())->where('id', $owner)->update([$column => $target]);
        $this->counts['links'] = ($this->counts['links'] ?? 0) + 1;
    }

    /**
     * @param array<string, mixed> $type
     * @param array<string, mixed> $data
     */
    private function locale(array $type, int|string $ref, array $data): void
    {
        $this->rows['plugin::i18n.locale'][$ref] = (int) DB::table((new ($type['model'])())->getTable())->insertGetId([
            'document_id' => $data['documentId'] ?? null,
            'code' => $data['code'],
            'name' => $data['name'] ?? $data['code'],
            'is_default' => false,
            'created_at' => self::value($data['createdAt'] ?? null, 'dateTime'),
            'updated_at' => self::value($data['updatedAt'] ?? null, 'dateTime'),
        ]);
    }

    /** @param list<array<string, mixed>> $links */
    private function links(array $links): void
    {
        $attach = [];
        foreach ($links as $index => $link) {
            [$left, $right] = [$link['left'], $link['right']];
            if (($link['kind'] ?? '') === 'relation.morph') {
                $owner = StrapiTransferMap::TYPES[$right['type']] ?? null;
                $descriptor = $owner['links'][$right['field']] ?? null;
                if (($descriptor['kind'] ?? null) !== 'media') {
                    $this->skipped["{$right['type']}.{$right['field']}"] = 'this project keeps no media there';

                    continue;
                }
                $attach[] = [$right['type'], $right['ref'], $descriptor['relation'], $this->rows['plugin::upload.file'][$left['ref']] ?? null, ['order' => $right['pos'] ?? 0], $right['pos'] ?? 0, $index];

                continue;
            }
            if (($right['type'] ?? null) === self::FOLDER && isset(StrapiTransferMap::TYPES[self::FOLDER]['model'])) {
                $this->folderLink($left, $right);

                continue;
            }
            if ($left['type'] === 'plugin::users-permissions.user' && $left['field'] === 'role') {
                $this->role($left['ref'], $this->roles[$right['ref']] ?? '');

                continue;
            }
            $descriptor = StrapiTransferMap::TYPES[$left['type']]['links'][$left['field']] ?? null;
            if ($descriptor === null) {
                // A link to or from a type this app does not import goes with that type.
                if (! isset(StrapiTransferMap::TYPES[$left['type']]['skip']) && ! isset(StrapiTransferMap::TYPES[$right['type']]['skip'])) {
                    $this->skipped["{$left['type']}.{$left['field']}"] = 'this project keeps no such link';
                }

                continue;
            }
            if ($descriptor['kind'] !== 'belongsToMany' || ! $this->keeps($left['type'], $right['type'], $right['ref'])) {
                continue;
            }
            // Each side's place in the other's list, as the archive gives it; StrapiLinkPivot puts
            // a link without one at the end.
            $orders = [];
            foreach (['order' => $left, 'inverseOrder' => $right] as $key => $side) {
                if ($descriptor[$key] !== null && ($side['pos'] ?? null) !== null) {
                    $orders[$descriptor[$key]] = $side['pos'];
                }
            }
            $attach[] = [$left['type'], $left['ref'], $descriptor['relation'], $this->rows[$right['type']][$right['ref']] ?? null, $orders, $left['pos'] ?? 0, $index];
        }
        // In each list's order: by position, then as the archive lists them.
        usort($attach, fn (array $a, array $b): int => [$a[0], $a[1], $a[2], $a[5], $a[6]] <=> [$b[0], $b[1], $b[2], $b[5], $b[6]]);
        $seen = [];
        foreach ($attach as [$uid, $ref, $name, $target, $pivot]) {
            $owner = $this->rows[$uid][$ref] ?? null;
            if ($owner === null || $target === null || isset($seen["{$uid}|{$owner}|{$name}|{$target}"])) {
                continue;
            }
            $seen["{$uid}|{$owner}|{$name}|{$target}"] = true;
            $model = new (StrapiTransferMap::TYPES[$uid]['model'])();
            $model->setAttribute($model->getKeyName(), $owner);
            $relation = $model->{$name}();
            assert($relation instanceof BelongsToMany || $relation instanceof MorphToMany);
            $relation->attach($target, $pivot);
            $this->counts['links'] = ($this->counts['links'] ?? 0) + 1;
        }
    }

    private function role(int|string $userRef, string $type): void
    {
        $id = $this->rows['plugin::users-permissions.user'][$userRef] ?? null;
        if (! class_exists(Role::class)) {
            $this->skipped['plugin::users-permissions.role'] = 'this project keeps no roles';

            return;
        }
        $name = Role::query()->where('name', $type)->exists() ? $type : StrapiTransferMap::DEFAULT_ROLE;
        if ($id === null || $name === null) {
            $this->skipped["role {$type}"] = 'this project has no such role';

            return;
        }
        if ($name !== $type) {
            $this->skipped["role {$type}"] = "this project has no such role; its users get {$name}";
        }
        User::query()->findOrFail($id)->syncRoles([$name]);
    }

    private function configuration(): void
    {
        DB::table('strapi_settings')->whereIn('key', [...array_values(self::SETTINGS), self::API_FOLDER[1]])->delete();
        DB::table('strapi_webhooks')->delete();
        $now = CarbonImmutable::now()->utc()->format('Y-m-d H:i:s');
        foreach ($this->lines('configuration') as $entry) {
            $value = $entry['value'] ?? [];
            if (($entry['type'] ?? null) === 'webhook') {
                DB::table('strapi_webhooks')->insert([
                    'name' => $value['name'] ?? null,
                    'url' => $value['url'] ?? null,
                    'headers' => json_encode((object) ($value['headers'] ?? []), JSON_THROW_ON_ERROR),
                    'events' => json_encode(array_values((array) ($value['events'] ?? [])), JSON_THROW_ON_ERROR),
                    'enabled' => (bool) ($value['enabled'] ?? $value['isEnabled'] ?? true),
                ]);
                $this->counts['webhooks'] = ($this->counts['webhooks'] ?? 0) + 1;

                continue;
            }
            $key = (string) ($value['key'] ?? '');
            $stored = is_string($value['value'] ?? null) && json_validate($value['value']) ? json_decode($value['value'], true) : ($value['value'] ?? null);
            if ($key === 'plugin_users-permissions_email' && is_array($stored)) {
                // Strapi keeps each template under its admin label; this app's mailer reads the options.
                $stored = array_map(fn (mixed $template): mixed => is_array($template) && is_array($template['options'] ?? null) ? $template['options'] : $template, $stored);
            }
            $locale = StrapiTransferMap::TYPES['plugin::i18n.locale']['model'] ?? null;
            if ($key === 'plugin_i18n_default_locale' && $locale !== null) {
                $table = (new $locale())->getTable();
                DB::table($table)->update(['is_default' => false]);
                DB::table($table)->where('code', (string) $stored)->update(['is_default' => true]);
            } elseif ($key === self::API_FOLDER[0]) {
                // The archive names the folder by its id there; it has another here.
                $folder = $this->rows[self::FOLDER][$stored['id'] ?? ''] ?? null;
                if ($folder === null) {
                    continue;
                }
                DB::table('strapi_settings')->insert(['key' => self::API_FOLDER[1], 'value' => json_encode(['id' => $folder], JSON_THROW_ON_ERROR), 'created_at' => $now, 'updated_at' => $now]);
            } elseif (isset(self::SETTINGS[$key])) {
                DB::table('strapi_settings')->insert(['key' => self::SETTINGS[$key], 'value' => json_encode($stored, JSON_THROW_ON_ERROR), 'created_at' => $now, 'updated_at' => $now]);
            } else {
                continue;
            }
            $this->counts['configuration'] = ($this->counts['configuration'] ?? 0) + 1;
        }
    }

    /** The files' bytes, onto this app's upload disk under the names their rows give. */
    private function assets(): void
    {
        $disk = StrapiUpload::disk();
        $kept = [];
        foreach ($this->entries as $path => $bytes) {
            if (! str_starts_with($path, 'assets/uploads/')) {
                continue;
            }
            $name = basename($path);
            $disk->put($name, $bytes);
            $kept[$name] = true;
            $this->counts['assets'] = ($this->counts['assets'] ?? 0) + 1;
        }
        $obsolete = array_values(array_filter(array_unique($this->obsolete), fn (string $n): bool => $n !== '' && ! isset($kept[$n])));
        if ($obsolete !== []) {
            $disk->delete($obsolete);
        }
    }

    /**
     * @param array<string, mixed> $data
     * @param list<string> $path
     */
    private static function at(array $data, array $path): mixed
    {
        foreach ($path as $key) {
            if (! is_array($data) || ! array_key_exists($key, $data)) {
                return null;
            }
            $data = $data[$key];
        }

        return $data;
    }

    /** An archived value as this app's column keeps it. */
    private static function value(mixed $value, string $type): mixed
    {
        if ($value === null) {
            return null;
        }

        return match ($type) {
            'dateTime', 'timestamp' => CarbonImmutable::parse((string) $value)->utc()->format('Y-m-d H:i:s'),
            'json', 'blocks' => json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            'boolean' => (bool) $value,
            default => is_array($value) ? json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE) : $value,
        };
    }
}
`;
