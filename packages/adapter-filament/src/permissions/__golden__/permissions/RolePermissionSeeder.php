<?php

declare(strict_types=1);

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Spatie\Permission\Models\Permission;
use Spatie\Permission\PermissionRegistrar;

class RolePermissionSeeder extends Seeder
{
    public function run(): void
    {
        app(PermissionRegistrar::class)->forgetCachedPermissions();
        // The configured role model: a Strapi API style app's keeps Strapi's millisecond timestamps.
        $role = app(PermissionRegistrar::class)->getRoleClass();

        Permission::firstOrCreate(['name' => 'article.read']);
        Permission::firstOrCreate(['name' => 'article.update']);

        $role::firstOrCreate(['name' => 'Editor'])->givePermissionTo(['article.read', 'article.update']);
    }
}
