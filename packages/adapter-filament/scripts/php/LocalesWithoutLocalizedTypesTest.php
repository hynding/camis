<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\Locale;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * Strapi's i18n plugin is always installed, so a project none of whose types is localized (the
 * author-role fixture) still lists its locales, starting with the default one, as strapi-php
 * does. CI's author-role job copies this into tests/Feature.
 */
class LocalesWithoutLocalizedTypesTest extends TestCase
{
    use RefreshDatabase;

    public function test_anyone_lists_the_default_locale(): void
    {
        $this->getJson('/api/i18n/locales')
            ->assertOk()
            ->assertJsonCount(1)
            ->assertJsonPath('0.code', 'en')
            ->assertJsonPath('0.name', 'English (en)')
            ->assertJsonPath('0.isDefault', true);
    }

    public function test_a_locale_added_in_the_admin_is_listed(): void
    {
        Locale::query()->create(['code' => 'fr', 'name' => 'French (fr)', 'is_default' => false]);

        $this->getJson('/api/i18n/locales')->assertOk()->assertJsonPath('1.code', 'fr');
    }
}
