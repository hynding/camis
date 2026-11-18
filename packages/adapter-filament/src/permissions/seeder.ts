export const emitSeeder = (
  permissionKeys: string[],
  roleGrants: { role: string; keys: string[] }[],
): string => {
  const perms = permissionKeys
    .map((k) => `        Permission::firstOrCreate(['name' => '${k}']);`)
    .join("\n");
  const roles = roleGrants
    .map(
      (r) =>
        `        $role::firstOrCreate(['name' => '${r.role}'])->givePermissionTo([${r.keys.map((k) => `'${k}'`).join(", ")}]);`,
    )
    .join("\n");
  return `<?php

declare(strict_types=1);

namespace Database\\Seeders;

use Illuminate\\Database\\Seeder;
use Spatie\\Permission\\Models\\Permission;
use Spatie\\Permission\\PermissionRegistrar;

class RolePermissionSeeder extends Seeder
{
    public function run(): void
    {
        app(PermissionRegistrar::class)->forgetCachedPermissions();
        // The configured role model: a Strapi API style app's keeps Strapi's millisecond timestamps.
        $role = app(PermissionRegistrar::class)->getRoleClass();

${perms}

${roles}
    }
}
`;
};
