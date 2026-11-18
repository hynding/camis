<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Spatie\Permission\PermissionRegistrar;
use Tests\TestCase;

/**
 * A strapi-php archive's users and roles keep the milliseconds of their times, as content types'
 * do (Phase 87): /api/users and the users-permissions roles answer what strapi-php answers. CI
 * copies this into the scaffolded app's tests/Feature.
 */
class TransferTimestampsTest extends TestCase
{
    use RefreshDatabase;

    private static function fixture(string $name): string
    {
        $directory = getenv('CAMIS_TRANSFER_FIXTURES') ?: base_path('../packages/adapter-filament/src/strapi-api/__fixtures__/transfer');

        return $directory.'/'.$name;
    }

    public function test_imported_users_and_roles_keep_their_milliseconds(): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        Artisan::call('strapi:import', ['--file' => self::fixture('strapi-php-export.tar.gz'), '--force' => true]);

        $alice = User::query()->where('username', 'alice')->firstOrFail();
        $this->assertSame('2026-10-29T02:24:42.482Z', $alice->created_at?->toIso8601ZuluString('millisecond'));

        $role = app(PermissionRegistrar::class)->getRoleClass()::query()->where('name', 'authenticated')->firstOrFail();
        $this->assertSame('2026-10-29T02:22:41.582Z', $role->created_at?->toIso8601ZuluString('millisecond'));
        $this->assertSame('2026-10-29T02:23:18.807Z', $role->updated_at?->toIso8601ZuluString('millisecond'));
    }
}
