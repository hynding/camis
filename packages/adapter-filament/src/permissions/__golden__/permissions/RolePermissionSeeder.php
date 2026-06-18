<?php

declare(strict_types=1);

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Spatie\Permission\Models\Permission;
use Spatie\Permission\Models\Role;
use Spatie\Permission\PermissionRegistrar;

class RolePermissionSeeder extends Seeder
{
    public function run(): void
    {
        app(PermissionRegistrar::class)->forgetCachedPermissions();

        Permission::firstOrCreate(['name' => 'article.read']);
        Permission::firstOrCreate(['name' => 'article.update']);

        Role::firstOrCreate(['name' => 'Editor'])->givePermissionTo(['article.read', 'article.update']);
    }
}
