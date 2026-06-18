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
        `        Role::firstOrCreate(['name' => '${r.role}'])->givePermissionTo([${r.keys.map((k) => `'${k}'`).join(", ")}]);`,
    )
    .join("\n");
  return `<?php

declare(strict_types=1);

namespace Database\\Seeders;

use Illuminate\\Database\\Seeder;
use Spatie\\Permission\\Models\\Permission;
use Spatie\\Permission\\Models\\Role;
use Spatie\\Permission\\PermissionRegistrar;

class RolePermissionSeeder extends Seeder
{
    public function run(): void
    {
        app(PermissionRegistrar::class)->forgetCachedPermissions();

${perms}

${roles}
    }
}
`;
};
