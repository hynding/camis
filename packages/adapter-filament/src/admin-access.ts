import type { GeneratedFile } from "@camis/adapter-kernel";
import type { CapabilityGap } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { PHP_MARKER } from "./hooks/names";
import { phpSingleQuoted } from "./php-literal";

/**
 * Who may sign in to the admin: a user holding a role the IR marks `admin`. Filament turns away
 * every user outside APP_ENV=local unless the User model implements FilamentUser, so the model
 * uses the AdminAccess trait (`camis scaffold` adds it), and `php artisan camis:admin` makes the
 * first admin. A project without roles has nothing to tell users apart by, so every signed-in
 * user is let in, as before roles existed.
 */
export const ADMIN_ACCESS_PATH = "app/Models/Concerns/AdminAccess.php";
export const ADMIN_COMMAND_PATH = "app/Console/Commands/CamisAdmin.php";

const adminRoles = (roles: readonly Role[]): string[] =>
  roles.filter((r) => r.admin === true).map((r) => r.name);

// Without roles there is nothing to tell users apart by; with roles, only an admin role lets in.
const emitAdminAccess = (everyUser: boolean, names: readonly string[]): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Models\\Concerns;

use Filament\\Panel;

/** The roles whose users may sign in to the admin; a blocked user never may. */
trait AdminAccess
{
    /** The project has no roles, so every signed-in user may use the admin. */
    public const EVERY_USER = ${everyUser ? "true" : "false"};

    public const ADMIN_ROLES = [${names.map(phpSingleQuoted).join(", ")}];

    public function canAccessPanel(Panel $panel): bool
    {
        if ((bool) $this->getAttribute('blocked')) {
            return false;
        }

        return ${everyUser ? "true" : "$this->hasAnyRole(self::ADMIN_ROLES)"};
    }
}
`;

const ADMIN_COMMAND = `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Console\\Commands;

use App\\Models\\User;
use Illuminate\\Console\\Command;
use Illuminate\\Support\\Facades\\Hash;
use Illuminate\\Support\\Facades\\Schema;
use Spatie\\Permission\\Models\\Role;

/** Makes a user who may sign in to the admin, or gives an existing user an admin role. */
final class CamisAdmin extends Command
{
    protected $signature = 'camis:admin
        {email : The admin\\'s email address}
        {--name= : The admin\\'s name (defaults to the part of the email before the @)}
        {--username= : The admin\\'s username, where users have one (defaults to the name)}
        {--password= : The admin\\'s password, at least 8 characters (asked for when left out)}
        {--role= : The admin role to give (defaults to the first one)}';

    protected $description = 'Create a user who may sign in to the admin, or give an existing user an admin role';

    public function handle(): int
    {
        if (! User::EVERY_USER && User::ADMIN_ROLES === []) {
            $this->error('No role may sign in to the admin: mark one with "admin": true in the roles file, then rebuild');

            return self::FAILURE;
        }
        $role = User::EVERY_USER ? null : $this->option('role') ?? User::ADMIN_ROLES[0];
        if ($role !== null && ! in_array($role, User::ADMIN_ROLES, true)) {
            $this->error("\\"{$role}\\" is not an admin role; admin roles: " . implode(', ', User::ADMIN_ROLES));

            return self::FAILURE;
        }
        if ($role !== null && Role::query()->where('name', $role)->doesntExist()) {
            $this->error("The role \\"{$role}\\" has not been seeded; run php artisan db:seed first");

            return self::FAILURE;
        }

        $email = (string) $this->argument('email');
        $user = User::query()->where('email', $email)->first();
        if ($user === null) {
            $password = $this->option('password') ?? $this->secret('Password');
            if (! is_string($password) || strlen($password) < 8) {
                $this->error('The password must be at least 8 characters');

                return self::FAILURE;
            }
            $name = $this->option('name') ?? strstr($email, '@', true) ?: $email;
            $user = new User();
            $user->forceFill(array_filter([
                'email' => $email,
                'name' => Schema::hasColumn($user->getTable(), 'name') ? $name : null,
                'username' => Schema::hasColumn($user->getTable(), 'username') ? ($this->option('username') ?? $name) : null,
                'confirmed' => Schema::hasColumn($user->getTable(), 'confirmed') ? true : null,
                'password' => Hash::make($password),
            ], static fn (mixed $value): bool => $value !== null));
            $user->save();
        } elseif ((bool) $user->getAttribute('blocked')) {
            $this->warn("{$email} is blocked, and stays out of the admin until unblocked");
        }

        if ($role !== null) {
            $user->assignRole($role);
        }
        $this->info("{$email} holds " . ($role === null ? 'no role: every signed-in user may use the admin' : "the admin role {$role}"));

        return self::SUCCESS;
    }
}
`;

const noAdminRole = (roles: readonly Role[]): CapabilityGap[] =>
  roles.length > 0 && adminRoles(roles).length === 0
    ? [
        {
          feature: "adminRole",
          location: {},
          severity: "downgrade",
          message:
            'no role may sign in to the admin: mark one with "admin": true, then run php artisan camis:admin',
        },
      ]
    : [];

export const emitAdminAccessFiles = (
  roles: readonly Role[],
): { files: GeneratedFile[]; gaps: CapabilityGap[] } => ({
  files: [
    { path: ADMIN_ACCESS_PATH, content: emitAdminAccess(roles.length === 0, adminRoles(roles)) },
    { path: ADMIN_COMMAND_PATH, content: ADMIN_COMMAND },
  ],
  gaps: noAdminRole(roles),
});
