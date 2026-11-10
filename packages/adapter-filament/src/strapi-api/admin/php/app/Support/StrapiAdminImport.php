<?php

declare(strict_types=1);

namespace App\Support;

use App\Models\AdminUser;
use Carbon\CarbonImmutable;
use Illuminate\Database\Connection;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Spatie\Permission\Models\Role;

/**
 * A Strapi project's admin accounts, brought over from its database: `strapi export` leaves admin
 * data out of its archive. Each account keeps its documentId, names, email, state and password
 * hash, so its owner signs in with the same password. Its Strapi admin roles become the IR's admin
 * roles of the same name: Super Admin is the IR's super-admin (else its first admin role), and any
 * other is the admin role named as it is (Editor → editor). A role with no match is reported.
 */
final class StrapiAdminImport
{
    private const CONNECTION = 'strapi-admins';

    private const SUPER_ADMIN = 'strapi-super-admin';

    /** @var list<string> what an imported account lost on the way */
    private array $notes = [];

    private function __construct(private readonly Connection $source)
    {
    }

    /** Strapi's database: a SQLite file's path, or a URL (`mysql://user:pass@host/db`, `pgsql://…`). */
    public static function open(string $database): self
    {
        $config = is_file($database)
            ? ['driver' => 'sqlite', 'database' => $database, 'prefix' => '', 'foreign_key_constraints' => false]
            : ['url' => $database, 'prefix' => ''];
        config(['database.connections.' . self::CONNECTION => $config]);
        DB::purge(self::CONNECTION);
        $source = DB::connection(self::CONNECTION);
        if (! $source->getSchemaBuilder()->hasTable('admin_users')) {
            throw new \RuntimeException("{$database} has no admin_users table: is it a Strapi 5 database?");
        }

        return new self($source);
    }

    /** @return list<string> the emails of accounts this app already has, which an import replaces */
    public function replaced(): array
    {
        $emails = AdminUser::query()->whereIn('email', $this->accounts()->map(fn (object $row): string => self::email($row)))->pluck('email')->all();
        sort($emails);

        return $emails;
    }

    /** @return int how many accounts were imported */
    public function run(): int
    {
        $count = 0;
        DB::transaction(function () use (&$count): void {
            $roles = $this->roles();
            foreach ($this->accounts() as $row) {
                $email = self::email($row);
                AdminUser::query()->where('email', $email)->delete();
                // Written past the model, so the hash is kept as Strapi made it rather than hashed again.
                $id = DB::table('admin_users')->insertGetId([
                    'document_id' => $row->document_id ?? null,
                    'firstname' => $row->firstname ?? null,
                    'lastname' => $row->lastname ?? null,
                    'username' => $row->username ?? null,
                    'email' => $email,
                    'password' => self::hash($row->password ?? null),
                    'is_active' => (bool) ($row->is_active ?? false),
                    'blocked' => (bool) ($row->blocked ?? false),
                    'prefered_language' => $row->prefered_language ?? null,
                    'created_at' => self::time($row->created_at ?? null) ?? CarbonImmutable::now(),
                    'updated_at' => self::time($row->updated_at ?? null) ?? CarbonImmutable::now(),
                ]);
                $admin = AdminUser::query()->findOrFail($id);
                foreach ($roles[$row->id] ?? [] as $role) {
                    $name = $this->adminRole($role);
                    if ($name === null) {
                        $this->notes[] = "{$email}: the Strapi admin role \"{$role->name}\" has no admin role of that name here; add one to the roles file, or give the account a role in the admin";
                    } else {
                        $admin->assignRole($name);
                    }
                }
                if (! (bool) ($row->is_active ?? false)) {
                    $this->notes[] = "{$email}: not active on Strapi (an invitation never accepted?), so it stays out of the admin until made active";
                }
                $count++;
            }
        });

        return $count;
    }

    /** @return list<string> */
    public function notes(): array
    {
        return $this->notes;
    }

    /** @return Collection<int, \stdClass> */
    private function accounts(): Collection
    {
        return $this->source->table('admin_users')->orderBy('id')->get();
    }

    /** @return array<int|string, list<\stdClass>> account id → its Strapi roles */
    private function roles(): array
    {
        $link = 'admin_users_roles_lnk';
        if (! $this->source->getSchemaBuilder()->hasTable($link) || ! $this->source->getSchemaBuilder()->hasTable('admin_roles')) {
            return [];
        }
        $rows = $this->source->table($link)
            ->join('admin_roles', 'admin_roles.id', '=', "{$link}.role_id")
            ->orderBy("{$link}.user_id")->orderBy("{$link}.id")
            ->get(["{$link}.user_id as account", 'admin_roles.name as name', 'admin_roles.code as code']);
        $roles = [];
        foreach ($rows as $row) {
            $roles[$row->account][] = $row;
        }

        return $roles;
    }

    /** The IR admin role a Strapi admin role becomes, when one is seeded here. */
    private function adminRole(object $role): ?string
    {
        $seeded = Role::query()->whereIn('name', AdminUser::ADMIN_ROLES)->pluck('name')->all();
        if (($role->code ?? null) === self::SUPER_ADMIN) {
            return in_array('super-admin', $seeded, true) ? 'super-admin' : (AdminUser::ADMIN_ROLES[0] ?? null);
        }
        $wanted = array_map('mb_strtolower', array_filter([
            (string) ($role->name ?? ''),
            preg_replace('/^strapi-/', '', (string) ($role->code ?? '')) ?? '',
        ]));
        foreach ($seeded as $name) {
            if (in_array(mb_strtolower($name), $wanted, true)) {
                return $name;
            }
        }

        return null;
    }

    private static function email(object $row): string
    {
        return mb_strtolower((string) $row->email);
    }

    /** bcryptjs writes `$2a$` (and `$2b$`), the same hash PHP verifies as `$2y$`. */
    private static function hash(mixed $hash): ?string
    {
        if (! is_string($hash) || $hash === '') {
            return null;
        }

        return preg_match('/^\$2[ab]\$/', $hash) === 1 ? '$2y$' . substr($hash, 4) : $hash;
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
