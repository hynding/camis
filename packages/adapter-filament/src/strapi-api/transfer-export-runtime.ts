import { PHP_MARKER } from "../hooks/names";

/**
 * Strapi's data export: the archive `strapi export` writes (`.tar`, `.tar.gz`, `.tar.gz.enc`),
 * read back from this app's tables through `StrapiTransferMap`, so Strapi (or strapi-php, or
 * camis) can import it. Every entry keeps its documentId, timestamps, components, draft and
 * published versions and locale; links are written from the side that declares them, as Strapi
 * lists them. A type without draft and publish links a draft-and-publish document through its
 * draft only here; Strapi links both versions, so the published twin is linked too. Roles carry
 * Strapi's default users-permissions actions plus the IR's grants (`StrapiTransferMap::ACTIONS`).
 * Schemas are Strapi's own for this IR (`resources/strapi/schemas.jsonl`), since Strapi's import
 * compares them to its own strictly. The canonical check is the boot job's round trip: an import
 * of strapi-php's archive, exported again, holds the same data.
 */
export const emitStrapiExport = (): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n` +
  String.raw`
use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasOneOrMany;
use Illuminate\Support\Facades\DB;
use Spatie\Permission\Models\Role;

final class StrapiExport
{
    public const STAGES = ['content', 'files', 'config'];

    /** The Strapi release whose archive format this writes. */
    public const STRAPI_VERSION = '5.56.0';

    public const SCHEMAS_PATH = 'strapi/schemas.jsonl';

    private const ROLE = 'plugin::users-permissions.role';

    private const USER = 'plugin::users-permissions.user';

    private const FILE = 'plugin::upload.file';

    /** Strapi's own roles, as users-permissions makes them: name, description, default actions. */
    private const ROLES = [
        'authenticated' => ['Authenticated', 'Default role given to authenticated user.', [
            'plugin::users-permissions.auth.logout', 'plugin::users-permissions.auth.getSessions',
            'plugin::users-permissions.auth.revokeSession', 'plugin::users-permissions.user.me',
            'plugin::users-permissions.auth.changePassword',
        ]],
        'public' => ['Public', 'Default role given to unauthenticated user.', [
            'plugin::users-permissions.auth.callback', 'plugin::users-permissions.auth.connect',
            'plugin::users-permissions.auth.forgotPassword', 'plugin::users-permissions.auth.resetPassword',
            'plugin::users-permissions.auth.register', 'plugin::users-permissions.auth.emailConfirmation',
            'plugin::users-permissions.auth.sendEmailConfirmation', 'plugin::users-permissions.auth.refresh',
        ]],
    ];

    private const FILE_COLUMNS = [
        'documentId' => 'document_id', 'name' => 'name', 'alternativeText' => 'alternative_text', 'caption' => 'caption',
        'focalPoint' => 'focal_point', 'width' => 'width', 'height' => 'height', 'formats' => 'formats', 'hash' => 'hash',
        'ext' => 'ext', 'mime' => 'mime', 'size' => 'size', 'url' => 'url', 'previewUrl' => 'preview_url', 'provider' => 'provider',
        'provider_metadata' => 'provider_metadata', 'folderPath' => 'folder_path', 'createdAt' => 'created_at',
        'updatedAt' => 'updated_at', 'publishedAt' => 'published_at',
    ];

    /** The icon Strapi's admin shows beside each email template. */
    private const EMAIL_ICONS = ['reset_password' => 'sync', 'email_confirmation' => 'check-square'];

    /** The users-permissions core-store keys this app keeps. */
    private const SETTINGS = ['plugin_users-permissions_advanced', 'plugin_users-permissions_email', 'plugin_users-permissions_grant'];

    /** @var array<string, resource> stage → its jsonl, written as it is read */
    private array $stages = [];

    /** @var array<string, int> */
    private array $counts = [];

    /** @var array<string, string> archive path → file on disk, for the files' bytes */
    private array $assets = [];

    /** @var array<string, string> archive path → the metadata Strapi keeps beside a file's bytes */
    private array $metadata = [];

    /** @var array<int, int> role id here → its entry's id in the archive */
    private array $roleRefs = [];

    private int $components = 0;

    /**
     * Strapi's --only and --exclude, over its three data types.
     *
     * @param list<string>|null $only
     * @param list<string>|null $exclude
     * @return list<string>
     */
    public static function stages(?array $only, ?array $exclude): array
    {
        return StrapiImport::stages($only, $exclude);
    }

    /**
     * Writes the archive for $file (without extension): '.tar', then '.gz' when compressed, then
     * '.enc' when a key encrypts it.
     *
     * @param list<string> $stages
     * @return array{path: string, counts: array<string, int>}
     */
    public static function write(string $file, array $stages, bool $compress, ?string $key): array
    {
        $export = new self();
        $path = $file . '.tar' . ($compress ? '.gz' : '') . ($key !== null ? '.enc' : '');
        $tar = $export->tar($stages);
        $current = $tar;
        if ($compress) {
            $current = self::gzip($current);
            unlink($tar);
        }
        if ($key !== null) {
            $encrypted = self::temporary();
            StrapiTransferCipher::encryptFile($current, $encrypted, $key);
            unlink($current);
            $current = $encrypted;
        }
        if (! rename($current, $path)) {
            throw new \RuntimeException("Cannot write {$path}");
        }
        ksort($export->counts);

        return ['path' => $path, 'counts' => $export->counts];
    }

    /** @param list<string> $stages */
    private function tar(array $stages): string
    {
        foreach (['entities', 'links', 'configuration'] as $stage) {
            $handle = fopen('php://temp', 'w+b');
            if ($handle === false) {
                throw new \RuntimeException('Cannot open a temporary stream');
            }
            $this->stages[$stage] = $handle;
        }
        $content = in_array('content', $stages, true);
        if ($content) {
            $this->roles();
            $this->users();
            $this->locales();
        }
        $this->files($content, in_array('files', $stages, true));
        if ($content) {
            foreach (StrapiTransferMap::TYPES as $uid => $type) {
                if (isset($type['attributes'])) {
                    $this->entries($uid, $type);
                }
            }
            foreach (StrapiTransferMap::TYPES as $uid => $type) {
                if (isset($type['attributes'])) {
                    $this->relationLinks($uid, $type);
                }
            }
        }
        if (in_array('config', $stages, true)) {
            $this->configuration();
        }

        $path = self::temporary();
        $out = fopen($path, 'wb');
        if ($out === false) {
            throw new \RuntimeException("Cannot write {$path}");
        }
        $metadata = ['createdAt' => CarbonImmutable::now()->utc()->format('Y-m-d\TH:i:s.v\Z'), 'strapi' => ['version' => self::STRAPI_VERSION]];
        self::entry($out, 'metadata.json', json_encode($metadata, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES));
        $schemas = file_get_contents(resource_path(self::SCHEMAS_PATH));
        if ($schemas === false) {
            throw new \RuntimeException('Cannot read resources/' . self::SCHEMAS_PATH);
        }
        self::entry($out, 'schemas/schemas_00001.jsonl', $schemas);
        foreach ($this->stages as $stage => $handle) {
            rewind($handle);
            self::entry($out, "{$stage}/{$stage}_00001.jsonl", (string) stream_get_contents($handle));
            fclose($handle);
        }
        foreach ($this->assets as $name => $file) {
            self::entryFromFile($out, $name, $file);
        }
        foreach ($this->metadata as $name => $json) {
            self::entry($out, $name, $json);
        }
        // Two empty blocks end a tar archive.
        fwrite($out, str_repeat("\0", 1024));
        fclose($out);

        return $path;
    }

    /** @param array<string, mixed> $record */
    private function line(string $stage, array $record): void
    {
        fwrite($this->stages[$stage], json_encode($record, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION) . "\n");
    }

    /** @param array<string, mixed> $data */
    private function entity(string $uid, int $id, array $data): void
    {
        $this->line('entities', ['type' => $uid, 'id' => $id, 'data' => $data]);
        $this->counts[$uid] = ($this->counts[$uid] ?? 0) + 1;
    }

    /**
     * @param array{type: string, ref: int, field?: string|null, pos?: int|null} $left
     * @param array{type: string, ref: int, field?: string|null, pos?: int|null} $right
     */
    private function link(string $kind, string $relation, array $left, array $right): void
    {
        $this->line('links', ['kind' => $kind, 'relation' => $relation, 'left' => array_filter($left, fn ($v) => $v !== null), 'right' => array_filter($right, fn ($v) => $v !== null)]);
        $this->counts['links'] = ($this->counts['links'] ?? 0) + 1;
    }

    /** Each role, with Strapi's default actions for its type and the actions of its grants. */
    private function roles(): void
    {
        $now = self::now();
        $roles = [];
        if (class_exists(Role::class)) {
            foreach (Role::query()->with('permissions')->orderBy('id')->get() as $role) {
                $roles[] = [(int) $role->id, (string) $role->name, $role->permissions->pluck('name')->all(), self::stamp($role->created_at) ?? $now, self::stamp($role->updated_at) ?? $now];
            }
        } else {
            // Without roles every caller may do everything the API offers.
            $all = array_keys(StrapiTransferMap::ACTIONS);
            $roles = [[0, 'authenticated', $all, $now, $now], [-1, 'public', $all, $now, $now]];
        }
        $permission = 0;
        foreach ($roles as $index => [$id, $type, $grants, $created, $updated]) {
            $ref = $index + 1;
            $this->roleRefs[$id] = $ref;
            [$name, $description, $defaults] = self::ROLES[$type] ?? [ucfirst(str_replace(['_', '-'], ' ', $type)), '', []];
            $this->entity(self::ROLE, $ref, [
                'documentId' => self::documentId(), 'name' => $name, 'description' => $description, 'type' => $type,
                'createdAt' => $created, 'updatedAt' => $updated, 'publishedAt' => $created, 'locale' => null,
            ]);
            $actions = $defaults;
            if (isset(StrapiTransferMap::TYPES['plugin::i18n.locale']['model'])) {
                // This app lists its locales to anyone, as Strapi does only when a role may.
                $actions[] = 'plugin::i18n.locales.listLocales';
            }
            foreach ($grants as $grant) {
                array_push($actions, ...(StrapiTransferMap::ACTIONS[$grant] ?? []));
            }
            foreach (array_values(array_unique($actions)) as $pos => $action) {
                $permission++;
                $this->entity('plugin::users-permissions.permission', $permission, [
                    'documentId' => self::documentId(), 'action' => $action,
                    'createdAt' => $created, 'updatedAt' => $created, 'publishedAt' => $created, 'locale' => null,
                ]);
                $this->link('relation.basic', 'manyToOne', ['type' => 'plugin::users-permissions.permission', 'field' => 'role', 'ref' => $permission], ['type' => self::ROLE, 'field' => 'permissions', 'ref' => $ref, 'pos' => $pos + 1]);
            }
        }
    }

    /** Every account, with its password hash, and the role it holds (its first, when several). */
    private function users(): void
    {
        $user = new User();
        $roleOf = [];
        if (class_exists(Role::class)) {
            $pivot = (string) config('permission.table_names.model_has_roles', 'model_has_roles');
            foreach (DB::table($pivot)->where('model_type', $user->getMorphClass())->orderBy('role_id')->get(['role_id', 'model_id']) as $row) {
                $roleOf[(int) $row->model_id] ??= $this->roleRefs[(int) $row->role_id] ?? null;
            }
        }
        $members = [];
        foreach (DB::table($user->getTable())->orderBy('id')->get() as $row) {
            $id = (int) $row->id;
            $created = self::stamp($row->created_at);
            $this->entity(self::USER, $id, [
                'documentId' => ($row->document_id ?? '') !== '' ? $row->document_id : self::documentId(),
                'username' => $row->username ?? $row->name,
                'email' => $row->email,
                'provider' => $row->provider ?? 'local',
                'password' => $row->password,
                'resetPasswordToken' => $row->reset_password_token ?? null,
                'confirmationToken' => $row->confirmation_token ?? null,
                'confirmed' => (bool) ($row->confirmed ?? false),
                'blocked' => (bool) ($row->blocked ?? false),
                'createdAt' => $created,
                'updatedAt' => self::stamp($row->updated_at),
                'publishedAt' => $created,
                'locale' => null,
            ]);
            $role = class_exists(Role::class) ? ($roleOf[$id] ?? null) : $this->roleRefs[0];
            if ($role !== null) {
                $members[$role] = ($members[$role] ?? 0) + 1;
                $this->link('relation.basic', 'manyToOne', ['type' => self::USER, 'field' => 'role', 'ref' => $id], ['type' => self::ROLE, 'field' => 'users', 'ref' => $role, 'pos' => $members[$role]]);
            }
        }
    }

    private function locales(): void
    {
        $model = StrapiTransferMap::TYPES['plugin::i18n.locale']['model'] ?? null;
        if ($model === null) {
            return;
        }
        foreach (DB::table((new $model())->getTable())->orderBy('id')->get() as $row) {
            $created = self::stamp($row->created_at);
            $this->entity('plugin::i18n.locale', (int) $row->id, [
                'documentId' => ($row->document_id ?? '') !== '' ? $row->document_id : self::documentId(),
                'name' => $row->name, 'code' => $row->code,
                'createdAt' => $created, 'updatedAt' => self::stamp($row->updated_at), 'publishedAt' => $created, 'locale' => null,
            ]);
        }
    }

    /**
     * The media library: each file's entry, and with its bytes the metadata Strapi keeps beside
     * them. A file whose bytes are on this app's upload disk goes as Strapi's local provider keeps
     * one, under /uploads.
     */
    private function files(bool $entries, bool $bytes): void
    {
        $model = StrapiTransferMap::TYPES[self::FILE]['model'] ?? null;
        if ($model === null || (! $entries && ! $bytes)) {
            return;
        }
        $disk = StrapiUpload::disk();
        foreach (DB::table((new $model())->getTable())->orderBy('id')->get() as $row) {
            $row = (array) $row;
            $data = [];
            foreach (self::FILE_COLUMNS as $key => $column) {
                $value = $row[$column] ?? null;
                $data[$key] = match ($key) {
                    'focalPoint', 'formats', 'provider_metadata' => self::json($value),
                    'createdAt', 'updatedAt', 'publishedAt' => self::stamp($value),
                    'width', 'height' => $value === null ? null : (int) $value,
                    'size' => $value === null ? null : (float) $value,
                    default => $value,
                };
            }
            $data['publishedAt'] ??= $data['createdAt'];
            $data['locale'] = null;
            $names = [basename((string) $data['url'])];
            foreach (is_array($data['formats']) ? $data['formats'] : [] as $format) {
                $names[] = basename((string) ($format['url'] ?? ''));
            }
            $local = $disk->exists($names[0]);
            if ($local) {
                $data['url'] = '/uploads/' . $names[0];
                $data['provider'] = 'local';
                foreach (is_array($data['formats']) ? $data['formats'] : [] as $type => $format) {
                    $data['formats'][$type]['url'] = '/uploads/' . basename((string) ($format['url'] ?? ''));
                }
            }
            $id = (int) $row['id'];
            if ($entries) {
                $this->entity(self::FILE, $id, $data);
            }
            if ($bytes && $local) {
                $this->asset($disk->path($names[0]), $names[0], ['id' => $id] + $data);
                foreach (is_array($data['formats']) ? $data['formats'] : [] as $type => $format) {
                    $name = basename((string) $format['url']);
                    if ($disk->exists($name)) {
                        $this->asset($disk->path($name), $name, $format + ['type' => $type, 'id' => $id, 'mainHash' => $data['hash']]);
                    }
                }
            }
        }
        if ($entries) {
            $this->mediaLinks();
        }
    }

    /** @param array<string, mixed> $metadata */
    private function asset(string $file, string $name, array $metadata): void
    {
        $this->assets["assets/uploads/{$name}"] = $file;
        $this->metadata["assets/metadata/{$name}.json"] = json_encode($metadata, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
        $this->counts['assets'] = ($this->counts['assets'] ?? 0) + 1;
    }

    /** Each media field's files, in its order, as Strapi's morph links from the file. */
    private function mediaLinks(): void
    {
        $owners = [];
        foreach (StrapiTransferMap::TYPES as $uid => $type) {
            if (isset($type['attributes'])) {
                $owners[(new ($type['model'])())->getMorphClass()] = $uid;
            }
        }
        $rows = DB::table('files_related_mph')->orderBy('related_type')->orderBy('related_id')->orderBy('field')->orderBy('order')->orderBy('id')->get();
        $positions = [];
        foreach ($rows as $row) {
            $uid = $owners[$row->related_type] ?? null;
            if ($uid === null) {
                continue;
            }
            $list = "{$uid}|{$row->related_id}|{$row->field}";
            $positions[$list] = ($positions[$list] ?? 0) + 1;
            $this->link('relation.morph', 'morphToMany', ['type' => self::FILE, 'field' => 'related', 'ref' => (int) $row->file_id], ['type' => $uid, 'ref' => (int) $row->related_id, 'field' => (string) $row->field, 'pos' => $positions[$list]]);
        }
    }

    /** @param array<string, mixed> $type */
    private function entries(string $uid, array $type): void
    {
        $model = new ($type['model'])();
        foreach (DB::table($model->getTable())->orderBy('id')->get() as $row) {
            $row = (array) $row;
            $id = (int) $row['id'];
            $data = ['documentId' => $row['document_id'] ?? null];
            $components = [];
            foreach ($type['attributes'] as $key => $attribute) {
                if ($attribute === null || in_array($key, ['documentId', 'createdAt', 'updatedAt', 'publishedAt', 'locale'], true)) {
                    continue;
                }
                if (isset($attribute['column'])) {
                    $data[$key] = self::value($row[$attribute['column']] ?? null, $attribute['type']);
                } elseif (isset($attribute['component'])) {
                    $components[$key] = $this->component($attribute['component'], $row);
                } elseif (isset($attribute['repeatable'])) {
                    $components[$key] = array_map(fn (array $child): array => $this->item($attribute['scalars'], $child), $this->children($model, $id, $attribute['repeatable']));
                } else {
                    $components[$key] = $this->zone($model, $id, $attribute['zone']);
                }
            }
            $created = self::value($row['created_at'] ?? null, 'dateTime');
            $data['createdAt'] = $created;
            $data['updatedAt'] = self::value($row['updated_at'] ?? null, 'dateTime');
            // Strapi publishes every entry of a type without draft and publish when it is made.
            $data['publishedAt'] = $type['draftPublish'] ? self::value($row['published_at'] ?? null, 'dateTime') : $created;
            $data['locale'] = $type['localized'] ? ($row['locale'] ?? null) : null;
            $this->entity($uid, $id, $data + $components);
        }
    }

    /** @return list<array<string, mixed>> */
    private function children(Model $model, int $id, string $relation, bool $positioned = false): array
    {
        $model->setAttribute($model->getKeyName(), $id);
        $children = $model->{$relation}();
        assert($children instanceof HasOneOrMany);
        $query = DB::table($children->getRelated()->getTable())->where($children->getForeignKeyName(), $id);
        if ($positioned) {
            $query->orderBy('position');
        }

        return array_map(fn (object $row): array => (array) $row, $query->orderBy('id')->get()->all());
    }

    /**
     * @param array<string, array{relation: string, scalars: list<array<string, mixed>>}> $members
     * @return list<array<string, mixed>>
     */
    private function zone(Model $model, int $id, array $members): array
    {
        $items = [];
        foreach ($members as $component => $member) {
            foreach ($this->children($model, $id, $member['relation'], true) as $child) {
                $items[] = [(int) ($child['position'] ?? 0), $component, $member['scalars'], $child];
            }
        }
        usort($items, fn (array $a, array $b): int => $a[0] <=> $b[0]);

        return array_map(fn (array $item): array => $this->item($item[2], $item[3]) + ['__component' => $item[1]], $items);
    }

    /**
     * One component instance: always there, even when every value is null.
     *
     * @param list<array<string, mixed>> $scalars
     * @param array<string, mixed> $row
     * @return array<string, mixed>
     */
    private function item(array $scalars, array $row): array
    {
        return $this->component($scalars, $row) ?? ['id' => ++$this->components];
    }

    /**
     * A component from its columns, its own components nested under their keys; null when it
     * holds no value at all, which is how this app keeps an absent one. Strapi gives each instance
     * an id, which an import maps to its own.
     *
     * @param list<array<string, mixed>> $scalars
     * @param array<string, mixed> $row
     * @return array<string, mixed>|null
     */
    private function component(array $scalars, array $row): ?array
    {
        $values = [];
        $nested = [];
        foreach ($scalars as $scalar) {
            $key = $scalar['key'];
            if (count($key) === 1) {
                $values[$key[0]] = self::value($row[$scalar['column']] ?? null, $scalar['type']);
            } else {
                $nested[$key[0]][] = ['key' => array_slice($key, 1)] + $scalar;
            }
        }
        $nested = array_map(fn (array $inner): ?array => $this->component($inner, $row), $nested);
        if (array_filter([...$values, ...$nested], fn ($v) => $v !== null) === []) {
            return null;
        }

        return ['id' => ++$this->components] + $values + $nested;
    }

    /**
     * The links this type declares, from its side. Strapi lists a list's members in order: a link
     * from a to-many side carries its position there, as does the target's side when its inverse
     * is a list.
     *
     * @param array<string, mixed> $type
     */
    private function relationLinks(string $uid, array $type): void
    {
        $model = new ($type['model'])();
        foreach ($type['links'] as $field => $link) {
            if (! isset($link['declares'])) {
                continue;
            }
            $target = StrapiTransferMap::TYPES[$link['target']] ?? [];
            $pairs = $this->pairs($model->{$link['relation']}());
            if (! $type['draftPublish'] && ($target['draftPublish'] ?? false) && $link['kind'] !== 'hasMany' && $link['kind'] !== 'hasOne') {
                $pairs = $this->withPublished($pairs, $target);
            }
            $leftMany = in_array($link['declares'], ['oneToMany', 'manyToMany'], true);
            $rightMany = $link['inverse'] !== null && in_array($link['declares'], ['manyToOne', 'manyToMany'], true);
            $leftPos = [];
            $rightPos = [];
            foreach ($this->rightPositions($pairs) as [$left, $right, $position]) {
                $leftPos[$left] = ($leftPos[$left] ?? 0) + 1;
                $this->link(
                    'relation.basic',
                    $link['declares'],
                    ['type' => $uid, 'field' => $field, 'ref' => $left, 'pos' => $leftMany ? $leftPos[$left] : null],
                    ['type' => $link['target'], 'field' => $link['inverse'], 'ref' => $right, 'pos' => $rightMany ? $position : null],
                );
            }
        }
    }

    /**
     * Who links whom, as [this side's id, the target's id], in each list's order.
     *
     * @return list<array{0: int, 1: int}>
     */
    private function pairs(mixed $relation): array
    {
        if ($relation instanceof BelongsTo) {
            $key = $relation->getForeignKeyName();
            $rows = DB::table($relation->getParent()->getTable())->whereNotNull($key)->orderBy('id')->get(['id', $key]);

            return $rows->map(fn (object $r): array => [(int) $r->id, (int) $r->{$key}])->all();
        }
        if ($relation instanceof BelongsToMany) {
            [$own, $other] = [$relation->getForeignPivotKeyName(), $relation->getRelatedPivotKeyName()];
            $rows = DB::table($relation->getTable())->orderBy($own)->orderBy($other)->get([$own, $other]);

            return $rows->map(fn (object $r): array => [(int) $r->{$own}, (int) $r->{$other}])->all();
        }
        assert($relation instanceof HasOneOrMany);
        $key = $relation->getForeignKeyName();
        $rows = DB::table($relation->getRelated()->getTable())->whereNotNull($key)->orderBy($key)->orderBy('id')->get(['id', $key]);

        return $rows->map(fn (object $r): array => [(int) $r->{$key}, (int) $r->id])->all();
    }

    /**
     * Each link to a draft, followed by the same link to that document's published version.
     *
     * @param list<array{0: int, 1: int}> $pairs
     * @param array<string, mixed> $target
     * @return list<array{0: int, 1: int}>
     */
    private function withPublished(array $pairs, array $target): array
    {
        $versions = DB::table((new ($target['model'])())->getTable())->get(['id', 'document_id', 'published_at', ...($target['localized'] ? ['locale'] : [])]);
        $published = [];
        foreach ($versions as $row) {
            if ($row->published_at !== null) {
                $published[$row->document_id . '|' . ($row->locale ?? '')] = (int) $row->id;
            }
        }
        $twin = [];
        foreach ($versions as $row) {
            if ($row->published_at === null) {
                $twin[(int) $row->id] = $published[$row->document_id . '|' . ($row->locale ?? '')] ?? null;
            }
        }
        $out = [];
        foreach ($pairs as [$left, $right]) {
            $out[] = [$left, $right];
            if (($twin[$right] ?? null) !== null) {
                $out[] = [$left, $twin[$right]];
            }
        }

        return $out;
    }

    /**
     * Each pair with its position in the target's list, which holds its linkers by id.
     *
     * @param list<array{0: int, 1: int}> $pairs
     * @return list<array{0: int, 1: int, 2: int}>
     */
    private function rightPositions(array $pairs): array
    {
        $byTarget = [];
        foreach ($pairs as [$left, $right]) {
            $byTarget[$right][] = $left;
        }
        $position = [];
        foreach ($byTarget as $right => $lefts) {
            sort($lefts);
            foreach (array_values(array_unique($lefts)) as $index => $left) {
                $position["{$left}|{$right}"] = $index + 1;
            }
        }

        return array_map(fn (array $p): array => [$p[0], $p[1], $position["{$p[0]}|{$p[1]}"]], $pairs);
    }

    private function configuration(): void
    {
        $id = 0;
        $store = function (string $key, mixed $value, string $type = 'object') use (&$id): void {
            $this->line('configuration', ['type' => 'core-store', 'value' => ['id' => ++$id, 'key' => $key, 'value' => $value, 'type' => $type, 'environment' => null, 'tag' => null]]);
            $this->counts['configuration'] = ($this->counts['configuration'] ?? 0) + 1;
        };
        [$advanced, $email, $grant] = self::SETTINGS;
        $store($advanced, StrapiUsers::advanced());
        $templates = [];
        foreach (StrapiUsers::emails() as $name => $options) {
            // This app's mailer reads a template's options; Strapi keeps them under its admin label.
            $templates[$name] = ['display' => "Email.template.{$name}", 'icon' => self::EMAIL_ICONS[$name] ?? 'envelope', 'options' => $options];
        }
        $store($email, $templates);
        $store($grant, StrapiProviders::settings());
        $locale = StrapiTransferMap::TYPES['plugin::i18n.locale']['model'] ?? null;
        if ($locale !== null) {
            $default = DB::table((new $locale())->getTable())->where('is_default', true)->value('code');
            if ($default !== null) {
                $store('plugin_i18n_default_locale', (string) $default, 'string');
            }
        }
        foreach (DB::table('strapi_webhooks')->orderBy('id')->get() as $webhook) {
            $this->line('configuration', ['type' => 'webhook', 'value' => [
                'id' => (int) $webhook->id,
                'name' => $webhook->name,
                'url' => $webhook->url,
                'headers' => (object) (self::json($webhook->headers) ?? []),
                'events' => array_values((array) (self::json($webhook->events) ?? [])),
                'enabled' => (bool) ($webhook->enabled ?? true),
            ]]);
            $this->counts['webhooks'] = ($this->counts['webhooks'] ?? 0) + 1;
        }
    }

    /** A column's value as Strapi's REST API gives it. */
    private static function value(mixed $value, string $type): mixed
    {
        if ($value === null) {
            return null;
        }

        return match ($type) {
            'integer' => (int) $value,
            'bigInteger' => (string) $value,
            'float', 'decimal' => (float) $value,
            'boolean' => (bool) $value,
            'date' => substr((string) $value, 0, 10),
            'time' => strlen((string) $value) >= 12 ? substr((string) $value, 0, 12) : substr((string) $value . ':00', 0, 8) . '.000',
            'dateTime', 'timestamp' => self::stamp($value),
            'json' => self::json($value),
            default => $value,
        };
    }

    private static function stamp(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }
        $time = $value instanceof \DateTimeInterface ? CarbonImmutable::instance($value) : CarbonImmutable::parse((string) $value, 'UTC');

        return $time->utc()->format('Y-m-d\TH:i:s.v\Z');
    }

    private static function json(mixed $value): mixed
    {
        return is_string($value) ? json_decode($value, true) : $value;
    }

    private static function now(): string
    {
        return CarbonImmutable::now()->utc()->format('Y-m-d\TH:i:s.v\Z');
    }

    /** A documentId as Strapi makes one: 24 lowercase letters and digits, the first a letter. */
    private static function documentId(): string
    {
        $alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
        $id = $alphabet[random_int(0, 25)];
        for ($i = 1; $i < 24; $i++) {
            $id .= $alphabet[random_int(0, 35)];
        }

        return $id;
    }

    private static function temporary(): string
    {
        $path = tempnam(sys_get_temp_dir(), 'strapi-export-');
        if ($path === false) {
            throw new \RuntimeException('Cannot create a temporary file');
        }

        return $path;
    }

    /** @param resource $out */
    private static function entry($out, string $name, string $bytes): void
    {
        fwrite($out, self::header($name, strlen($bytes)));
        fwrite($out, $bytes);
        fwrite($out, str_repeat("\0", (512 - strlen($bytes) % 512) % 512));
    }

    /** @param resource $out */
    private static function entryFromFile($out, string $name, string $file): void
    {
        $in = fopen($file, 'rb');
        $size = filesize($file);
        if ($in === false || $size === false) {
            throw new \RuntimeException("Cannot read {$file}");
        }
        fwrite($out, self::header($name, $size));
        stream_copy_to_stream($in, $out);
        fclose($in);
        fwrite($out, str_repeat("\0", (512 - $size % 512) % 512));
    }

    /** A ustar header; a path longer than 100 bytes is split into its prefix and name. */
    private static function header(string $path, int $size): string
    {
        [$prefix, $name] = ['', $path];
        if (strlen($path) > 100) {
            $cut = strrpos(substr($path, 0, 156), '/');
            if ($cut === false || strlen($path) - $cut - 1 > 100) {
                throw new \RuntimeException("{$path} is too long for a tar archive");
            }
            [$prefix, $name] = [substr($path, 0, $cut), substr($path, $cut + 1)];
        }
        $header = str_pad($name, 100, "\0")
            . sprintf('%07o', 0644) . "\0"
            . sprintf('%07o', 0) . "\0"
            . sprintf('%07o', 0) . "\0"
            . sprintf('%011o', $size) . "\0"
            . sprintf('%011o', time()) . "\0"
            . str_repeat(' ', 8)
            . '0'
            . str_repeat("\0", 100)
            . "ustar\0" . '00'
            . str_repeat("\0", 32)
            . str_repeat("\0", 32)
            . str_repeat("\0", 8)
            . str_repeat("\0", 8)
            . str_pad($prefix, 155, "\0")
            . str_repeat("\0", 12);
        $checksum = array_sum(array_map('ord', str_split($header)));

        return substr_replace($header, sprintf('%06o', $checksum) . "\0 ", 148, 8);
    }

    private static function gzip(string $file): string
    {
        $path = self::temporary();
        $in = fopen($file, 'rb');
        $out = gzopen($path, 'wb6');
        if ($in === false || $out === false) {
            throw new \RuntimeException('Cannot compress the archive');
        }
        while (! feof($in)) {
            gzwrite($out, (string) fread($in, 1 << 20));
        }
        fclose($in);
        gzclose($out);

        return $path;
    }
}
`;
