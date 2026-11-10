import type { GeneratedFile } from "@camis/adapter-kernel";
import type { CapabilityGap } from "@camis/ir-schema";
import type { Role } from "@camis/permissions";
import { PHP_MARKER } from "./hooks/names";
import { phpSingleQuoted } from "./php-literal";
import { runtimePhp } from "./runtime-php";

/**
 * Who may sign in to the admin: an admin account holding a role the IR marks `admin`. Admin
 * accounts are AdminUser rows in Strapi's admin_users table, apart from the API's users, as Strapi
 * keeps admin_users apart from up_users; the generated config/auth.php gives them the admin guard,
 * which the admin panel signs in on (`camis scaffold` sets its authGuard), and
 * `php artisan camis:admin` makes the first one. A project without
 * roles has nothing to tell accounts apart by, so every active admin account is let in.
 */
export const ADMIN_ACCESS_PATH = "app/Models/Concerns/AdminAccess.php";
export const ADMIN_COMMAND_PATH = "app/Console/Commands/CamisAdmin.php";
export const ADMIN_USER_MODEL_PATH = "app/Models/AdminUser.php";
export const ADMIN_USERS_MIGRATION_PATH =
  "database/migrations/0001_01_01_000003_create_admin_users_table.php";
export const AUTH_CONFIG_PATH = "config/auth.php";

const adminPhp = (path: string): string =>
  runtimePhp(new URL(`./strapi-api/admin/php/${path}`, import.meta.url));

const adminRoles = (roles: readonly Role[]): string[] =>
  roles.filter((r) => r.admin === true).map((r) => r.name);

// Without roles there is nothing to tell accounts apart by; with roles, only an admin role lets in.
// An app whose admin panel still signs in on the web guard (built before admin accounts were
// separate) lets its admins in as Users, which use this trait too and have no is_active.
const emitAdminAccess = (everyUser: boolean, names: readonly string[]): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Models\\Concerns;

use App\\Models\\AdminUser;
use Filament\\Panel;

/** The roles whose admin accounts may sign in to the admin; an inactive or blocked one never may. */
trait AdminAccess
{
    /** The project has no roles, so every active admin account may use the admin. */
    public const EVERY_USER = ${everyUser ? "true" : "false"};

    public const ADMIN_ROLES = [${names.map(phpSingleQuoted).join(", ")}];

    public function canAccessPanel(Panel $panel): bool
    {
        if ((bool) $this->getAttribute('blocked') || ($this instanceof AdminUser && ! (bool) $this->getAttribute('is_active'))) {
            return false;
        }

        return ${everyUser ? "true" : "$this->hasAnyRole(self::ADMIN_ROLES)"};
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
    { path: ADMIN_COMMAND_PATH, content: adminPhp(ADMIN_COMMAND_PATH) },
    { path: ADMIN_USER_MODEL_PATH, content: adminPhp(ADMIN_USER_MODEL_PATH) },
    { path: ADMIN_USERS_MIGRATION_PATH, content: adminPhp(ADMIN_USERS_MIGRATION_PATH) },
    { path: AUTH_CONFIG_PATH, content: adminPhp(AUTH_CONFIG_PATH) },
  ],
  gaps: noAdminRole(roles),
});
