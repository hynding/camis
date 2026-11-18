<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Locale;
use App\Models\User;
use App\Support\StrapiApiTokens;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Strapi's i18n plugin is always installed, so a project none of whose types is localized (the
 * author-role fixture) still lists its locales, starting with the default one, as strapi-php
 * does: to a token holding plugin::i18n.locales.listLocales, as no role Strapi ships holds it.
 * CI's author-role job copies this into tests/Feature.
 */
class LocalesWithoutLocalizedTypesTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
    }

    private function asClient(string $key): static
    {
        $this->app['auth']->forgetGuards();

        return $this->withHeader('Authorization', 'Bearer '.$key);
    }

    private function fullAccess(): string
    {
        return StrapiApiTokens::create(['name' => 'all', 'type' => 'full-access'])['accessKey'];
    }

    public function test_a_full_access_token_lists_the_default_locale(): void
    {
        $this->asClient($this->fullAccess())->getJson('/api/i18n/locales')
            ->assertOk()
            ->assertJsonCount(1)
            ->assertJsonPath('0.code', 'en')
            ->assertJsonPath('0.name', 'English (en)')
            ->assertJsonPath('0.isDefault', true);
    }

    public function test_a_locale_added_in_the_admin_is_listed(): void
    {
        Locale::query()->create(['code' => 'fr', 'name' => 'French (fr)', 'is_default' => false]);

        $this->asClient($this->fullAccess())->getJson('/api/i18n/locales')->assertOk()->assertJsonPath('1.code', 'fr');
    }

    public function test_no_role_strapi_ships_lists_them(): void
    {
        $this->getJson('/api/i18n/locales')->assertForbidden()->assertJsonPath('error.name', 'ForbiddenError');

        $user = User::factory()->create(['username' => 'reader']);
        $user->assignRole('authenticated');
        $this->asClient($user->createToken('api')->plainTextToken)->getJson('/api/i18n/locales')->assertForbidden();
    }
}
