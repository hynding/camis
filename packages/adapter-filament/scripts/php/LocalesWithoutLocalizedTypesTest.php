<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Locale;
use App\Support\StrapiApiTokens;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Strapi's i18n plugin is always installed, so a project none of whose types is localized (the
 * author-role fixture) still lists its locales, starting with the default one, as strapi-php
 * does. Listing them is plugin::i18n.locales.listLocales, which this fixture's roles do not hold:
 * only a token holding it lists them. CI's author-role job copies this into tests/Feature.
 */
class LocalesWithoutLocalizedTypesTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
    }

    /** @return TestResponse<\Illuminate\Http\JsonResponse> */
    private function listWithToken(): TestResponse
    {
        $key = StrapiApiTokens::create(['name' => 'all', 'type' => 'full-access'])['accessKey'];
        $this->app['auth']->forgetGuards();

        return $this->getJson('/api/i18n/locales', ['Authorization' => 'Bearer '.$key]);
    }

    public function test_a_caller_whose_role_does_not_hold_the_list_is_forbidden(): void
    {
        $this->getJson('/api/i18n/locales')->assertForbidden();
    }

    public function test_a_full_access_token_lists_the_default_locale(): void
    {
        $this->listWithToken()
            ->assertOk()
            ->assertJsonCount(1)
            ->assertJsonPath('0.code', 'en')
            ->assertJsonPath('0.name', 'English (en)')
            ->assertJsonPath('0.isDefault', true);
    }

    public function test_a_locale_added_in_the_admin_is_listed(): void
    {
        Locale::query()->create(['code' => 'fr', 'name' => 'French (fr)', 'is_default' => false]);

        $this->listWithToken()->assertOk()->assertJsonPath('1.code', 'fr');
    }
}
