<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Entries\Pages\CreateEntry;
use App\Models\AdminUser;
use App\Models\Entry;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * String columns sized by their bound (the string-sizes fixture, issue #126): each column keeps a
 * value at its field's bound in four-byte characters, the worst case it is sized for, and the Strapi
 * API style and the admin form refuse one character more, counting characters as mb_strlen does.
 * A VARCHAR(1000) of utf8mb4 alone would take 4,000 of the 65,535 bytes a MySQL row may take, and a
 * unique one more than the 3,072 bytes an index key holds, so the migration must succeed first. CI's
 * text-columns job copies this into the scaffolded app's tests/Feature, once per database.
 */
class StringSizesTest extends TestCase
{
    use RefreshDatabase;

    private function wide(int $characters): string
    {
        return str_repeat("\u{1F600}", $characters);
    }

    public function test_each_column_keeps_a_value_at_its_bound(): void
    {
        $values = [
            'code' => $this->wide(40),
            'headline' => $this->wide(1000),
            'abstract' => $this->wide(20_000),
            'contact' => $this->wide(320),
            'slug' => $this->wide(300),
            // PostgreSQL refuses an index entry past about 2,700 bytes, so the longest unique value
            // is kept in one-byte characters.
            'handle' => str_repeat('a', 768),
        ];
        $entry = Entry::query()->create($values);

        $found = Entry::query()->findOrFail($entry->getKey());
        foreach ($values as $column => $value) {
            $this->assertSame($value, $found->{$column}, $column);
        }
    }

    public function test_the_api_takes_a_value_at_its_bound_and_refuses_one_past_it(): void
    {
        $this->postJson('/api/entries', ['data' => ['headline' => $this->wide(1000)]])->assertStatus(201);

        $this->postJson('/api/entries', ['data' => ['headline' => $this->wide(1001)]])
            ->assertStatus(400)
            ->assertJsonPath('error.details.errors.0.path', ['headline']);
    }

    public function test_the_admin_form_takes_a_value_at_its_bound_and_refuses_one_past_it(): void
    {
        // The fixture states no roles, so no policy guards the admin.
        $admin = AdminUser::query()->forceCreate(['firstname' => 'Admin', 'email' => 'admin@example.test', 'is_active' => true]);
        $this->actingAs($admin, 'admin');
        Filament::setCurrentPanel(Filament::getPanel('admin'));

        Livewire::test(CreateEntry::class)
            ->fillForm(['code' => $this->wide(40), 'headline' => $this->wide(1000)])
            ->call('create')
            ->assertHasNoFormErrors();
        $this->assertSame($this->wide(1000), Entry::query()->sole()->headline);

        Livewire::test(CreateEntry::class)
            ->fillForm(['code' => $this->wide(41), 'headline' => $this->wide(1001)])
            ->call('create')
            ->assertHasFormErrors(['code' => 'max', 'headline' => 'max']);
    }
}
