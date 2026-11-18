<?php

declare(strict_types=1);

namespace App\Support;

use App\Models\AdminUser;
use App\Models\StrapiAdminToken;
use App\Models\StrapiApiToken;
use App\Models\StrapiTransferToken;
use Carbon\CarbonImmutable;
use Illuminate\Database\Connection;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;

final class StrapiTokenImport
{
    private const CONNECTION = 'strapi-tokens';

    /** @var array<string, string> token → why it was not imported */
    private array $skipped = [];

    /** @var list<string> what an imported token lost on the way */
    private array $notes = [];

    private function __construct(private readonly Connection $source, private readonly ?string $encryptionKey)
    {
    }

    /**
     * Strapi's database: a SQLite file's path, or a URL (`mysql://user:pass@host/db`,
     * `pgsql://…`, `sqlite:///path`). $encryptionKey is Strapi's ENCRYPTION_KEY.
     */
    public static function open(string $database, ?string $encryptionKey = null): self
    {
        $config = is_file($database)
            ? ['driver' => 'sqlite', 'database' => $database, 'prefix' => '', 'foreign_key_constraints' => false]
            : ['url' => $database, 'prefix' => ''];
        config(['database.connections.' . self::CONNECTION => $config]);
        DB::purge(self::CONNECTION);
        $source = DB::connection(self::CONNECTION);
        if (! $source->getSchemaBuilder()->hasTable('strapi_api_tokens')) {
            throw new \RuntimeException("{$database} has no strapi_api_tokens table: is it a Strapi 5 database?");
        }

        return new self($source, $encryptionKey === '' ? null : $encryptionKey);
    }

    /** @return list<string> the names of tokens this app already has, which an import replaces */
    public function replaced(): array
    {
        $names = [
            ...DB::table('strapi_api_tokens')->whereIn('name', $this->apiTokens()->pluck('name'))->pluck('name')->all(),
            ...StrapiTransferToken::query()->whereIn('name', $this->transferTokens()->pluck('name'))->pluck('name')->all(),
        ];
        sort($names);

        return $names;
    }

    /** @return array{api: int, admin: int, transfer: int} */
    public function run(): array
    {
        $counts = ['api' => 0, 'admin' => 0, 'transfer' => 0];
        DB::transaction(function () use (&$counts): void {
            $actions = $this->actions('strapi_api_token_permissions', 'api_token');
            $owners = $this->owners();
            $adminPermissions = $this->adminPermissions();
            foreach ($this->apiTokens() as $row) {
                // An admin token (Strapi 5.40's kind) acts as its owner, the admin account of the same email here.
                if (($row->kind ?? 'content-api') === 'admin') {
                    $owner = AdminUser::query()->where('email', $owners[$row->id] ?? '')->first();
                    if ($owner === null) {
                        $this->skipped["Admin token {$row->name}"] = 'no admin account here has its owner\'s email: import the accounts first (strapi:import-admins)';

                        continue;
                    }
                    DB::table('strapi_api_tokens')->where('name', $row->name)->delete();
                    (new StrapiAdminToken())->forceFill([
                        'name' => $row->name,
                        'description' => (string) ($row->description ?? ''),
                        'admin_user_owner_id' => $owner->id,
                        'admin_permissions' => StrapiAdminPermissions::fromStrapi($adminPermissions[$row->id] ?? []),
                        'access_key' => $row->access_key,
                        'encrypted_key' => $this->reencrypt($row->name, $row->encrypted_key ?? null),
                    ] + self::times($row))->saveQuietly();
                    $counts['admin']++;

                    continue;
                }
                DB::table('strapi_api_tokens')->where('name', $row->name)->delete();
                (new StrapiApiToken())->forceFill([
                    'name' => $row->name,
                    'description' => (string) ($row->description ?? ''),
                    'type' => $row->type,
                    'access_key' => $row->access_key,
                    'encrypted_key' => $this->reencrypt($row->name, $row->encrypted_key ?? null),
                    'permissions' => $row->type === 'custom' ? ($actions[$row->id] ?? []) : null,
                ] + self::times($row))->saveQuietly();
                $counts['api']++;
            }
            $permissions = $this->actions('strapi_transfer_token_permissions', 'transfer_token');
            foreach ($this->transferTokens() as $row) {
                StrapiTransferToken::query()->where('name', $row->name)->delete();
                (new StrapiTransferToken())->forceFill([
                    'name' => $row->name,
                    'description' => (string) ($row->description ?? ''),
                    'access_key' => $row->access_key,
                    'permissions' => StrapiTransferTokens::permissions($permissions[$row->id] ?? []),
                ] + self::times($row))->saveQuietly();
                $counts['transfer']++;
            }
        });

        return $counts;
    }

    /** @return array<string, string> */
    public function skipped(): array
    {
        ksort($this->skipped);

        return $this->skipped;
    }

    /** @return list<string> */
    public function notes(): array
    {
        return $this->notes;
    }

    /** @return \Illuminate\Support\Collection<int, object> */
    private function apiTokens(): \Illuminate\Support\Collection
    {
        return $this->source->table('strapi_api_tokens')->orderBy('id')->get();
    }

    /** @return \Illuminate\Support\Collection<int, object> */
    private function transferTokens(): \Illuminate\Support\Collection
    {
        return $this->source->getSchemaBuilder()->hasTable('strapi_transfer_tokens')
            ? $this->source->table('strapi_transfer_tokens')->orderBy('id')->get()
            : collect();
    }

    /**
     * Each token's actions, in the order Strapi lists them: a permission row per action, joined to
     * its token through Strapi's link table.
     *
     * @return array<int|string, list<string>> token id → actions
     */
    private function actions(string $table, string $owner): array
    {
        $link = "{$table}_token_lnk";
        if (! $this->source->getSchemaBuilder()->hasTable($link)) {
            return [];
        }
        $permission = substr($owner, 0, -strlen('token')) . 'token_permission';
        $rows = $this->source->table($link)
            ->join($table, "{$table}.id", '=', "{$link}.{$permission}_id")
            ->orderBy("{$link}.{$owner}_id")->orderBy("{$link}.{$permission}_ord")->orderBy("{$link}.id")
            ->get(["{$link}.{$owner}_id as token", "{$table}.action as action"]);
        $actions = [];
        foreach ($rows as $row) {
            $actions[$row->token][] = (string) $row->action;
        }

        return array_map(fn (array $list): array => array_values(array_unique($list)), $actions);
    }

    /** @return array<int|string, string> admin token id → its owner's email */
    private function owners(): array
    {
        $link = 'strapi_api_tokens_admin_user_owner_lnk';
        if (! $this->source->getSchemaBuilder()->hasTable($link)) {
            return [];
        }

        return $this->source->table($link)
            ->join('admin_users', 'admin_users.id', '=', "{$link}.user_id")
            ->pluck('admin_users.email', "{$link}.api_token_id")
            ->map(fn (mixed $email): string => mb_strtolower((string) $email))
            ->all();
    }

    /** @return array<int|string, list<array{action: string, subject: string|null}>> admin token id → its permission rows */
    private function adminPermissions(): array
    {
        $link = 'admin_permissions_api_token_lnk';
        if (! $this->source->getSchemaBuilder()->hasTable($link)) {
            return [];
        }
        $rows = $this->source->table($link)
            ->join('admin_permissions', 'admin_permissions.id', '=', "{$link}.permission_id")
            ->orderBy("{$link}.api_token_id")->orderBy("{$link}.id")
            ->get(["{$link}.api_token_id as token", 'admin_permissions.action as action', 'admin_permissions.subject as subject']);
        $permissions = [];
        foreach ($rows as $row) {
            $permissions[$row->token][] = ['action' => (string) $row->action, 'subject' => $row->subject === null ? null : (string) $row->subject];
        }

        return $permissions;
    }

    /** Strapi's `v1:<iv>:<ciphertext>:<tag>` (AES-256-GCM under a SHA-256 of its ENCRYPTION_KEY), kept under this app's key. */
    private function reencrypt(string $name, ?string $encrypted): ?string
    {
        if ($encrypted === null || $encrypted === '') {
            return null;
        }
        if ($this->encryptionKey === null) {
            $this->notes[] = "API token {$name}: its key works, but the admin cannot show it again without the Strapi project's ENCRYPTION_KEY (--encryption-key)";

            return null;
        }
        [$version, $iv, $ciphertext, $tag] = array_pad(explode(':', $encrypted), 4, '');
        $plain = $version === 'v1'
            ? openssl_decrypt((string) hex2bin($ciphertext), 'aes-256-gcm', hash('sha256', $this->encryptionKey, true), OPENSSL_RAW_DATA, (string) hex2bin($iv), (string) hex2bin($tag))
            : false;
        if ($plain === false) {
            $this->notes[] = "API token {$name}: its key works, but this ENCRYPTION_KEY does not decrypt it, so the admin cannot show it again";

            return null;
        }

        return Crypt::encryptString($plain);
    }

    /** @return array<string, mixed> */
    private static function times(object $row): array
    {
        return [
            'last_used_at' => self::time($row->last_used_at ?? null),
            'expires_at' => self::time($row->expires_at ?? null),
            'lifespan' => ($row->lifespan ?? null) === null ? null : (int) $row->lifespan,
            'created_at' => self::time($row->created_at ?? null) ?? CarbonImmutable::now(),
            'updated_at' => self::time($row->updated_at ?? null) ?? CarbonImmutable::now(),
        ];
    }

    /** A Strapi datetime: milliseconds since the epoch on SQLite, a date string elsewhere. */
    private static function time(mixed $value): ?CarbonImmutable
    {
        if ($value === null || $value === '') {
            return null;
        }

        return is_numeric($value) ? CarbonImmutable::createFromTimestampMs((int) $value) : CarbonImmutable::parse((string) $value, 'UTC');
    }
}
