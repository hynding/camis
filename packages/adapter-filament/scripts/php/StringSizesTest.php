<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Entries\Pages\CreateEntry;
use App\Models\AdminUser;
use App\Models\Entry;
use App\Models\User;
use App\Support\StrapiAdminTokens;
use App\Support\StrapiMcpServer;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * String columns sized by their bound (the string-sizes fixture, issue #126): each column keeps a
 * value at its field's bound in four-byte characters, the worst case it is sized for, and the Strapi
 * API style, its MCP tools and the admin form refuse one character more, counting characters as
 * mb_strlen does.
 * A VARCHAR(1000) of utf8mb4 alone would take 4,000 of the 65,535 bytes a MySQL row may take, and a
 * unique one more than a PostgreSQL btree entry or a MySQL index key holds, so the migration must
 * succeed first, and a value past a capped column is refused as invalid rather than failing there. CI's
 * text-columns job copies this into the scaffolded app's tests/Feature, once per database.
 */
class StringSizesTest extends TestCase
{
    use RefreshDatabase;

    private const GRANTS = ['entry.create', 'entry.read', 'entry.update', 'entry.delete'];

    private string $jwt;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $user = User::factory()->create(['username' => 'writer']);
        $user->assignRole('authenticated');
        $this->jwt = $user->createToken('api')->plainTextToken;
    }

    private function api(array $data): TestResponse
    {
        return $this->withHeader('Authorization', 'Bearer '.$this->jwt)->postJson('/api/entries', ['data' => $data]);
    }

    private function admin(): AdminUser
    {
        $admin = AdminUser::query()->forceCreate(['firstname' => 'Admin', 'email' => 'admin@example.test', 'is_active' => true]);
        $admin->givePermissionTo(self::GRANTS);

        return $admin;
    }

    /**
     * A tools/call of the Strapi API style's MCP server, with an admin token holding the grants.
     *
     * @return array<string, mixed>
     */
    private function mcp(AdminUser $owner, string $tool, array $arguments): array
    {
        ['token' => $token] = StrapiAdminTokens::create($owner, ['name' => uniqid('mcp '), 'admin_permissions' => self::GRANTS]);
        $answer = (new StrapiMcpServer($token, $owner))->handle([
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => 'tools/call',
            'params' => ['name' => $tool, 'arguments' => $arguments],
        ]);

        return $answer['result'];
    }

    private function wide(int $characters): string
    {
        return str_repeat("\u{1F600}", $characters);
    }

    /** Four-byte characters that do not repeat, from the CJK Extension B block. */
    private function distinct(int $characters): string
    {
        $out = '';
        for ($i = 0; $i < $characters; $i++) {
            $out .= mb_chr(0x20000 + $i, 'UTF-8');
        }

        return $out;
    }

    public function test_each_column_keeps_a_value_at_its_bound(): void
    {
        $values = [
            'code' => $this->wide(40),
            'headline' => $this->wide(1000),
            'abstract' => $this->wide(20_000),
            'contact' => $this->wide(320),
            'slug' => $this->wide(300),
            // The cap a PostgreSQL btree entry holds, in distinct four-byte characters, which it
            // cannot compress below the 2,704 bytes an entry holds.
            'handle' => $this->distinct(673),
        ];
        $entry = Entry::query()->create($values);

        $found = Entry::query()->findOrFail($entry->getKey());
        foreach ($values as $column => $value) {
            $this->assertSame($value, $found->{$column}, $column);
        }
    }

    public function test_the_api_takes_a_value_at_its_bound_and_refuses_one_past_it(): void
    {
        $this->api(['headline' => $this->wide(1000)])->assertStatus(201);

        $this->api(['headline' => $this->wide(1001)])
            ->assertStatus(400)
            ->assertJsonPath('error.details.errors.0.path', ['headline']);
    }

    public function test_a_create_without_a_defaulted_field_stores_its_default(): void
    {
        // MySQL takes no default on the text columns of tagline and summary, so the model applies
        // theirs; label's string column keeps its own.
        $made = Entry::query()->create(['title' => 'model']);
        $found = Entry::query()->findOrFail($made->getKey());
        $this->assertSame(['hi', 'hello', 'none'], [$found->label, $found->tagline, $found->summary]);

        $id = $this->api(['title' => 'api'])->assertStatus(201)->json('data.id');
        $found = Entry::query()->findOrFail($id);
        $this->assertSame(['hi', 'hello', 'none'], [$found->label, $found->tagline, $found->summary]);
    }

    public function test_the_api_refuses_a_value_its_capped_column_cannot_hold(): void
    {
        // handle is bounded at 1000 characters, its unique column capped at 673.
        $this->api(['handle' => $this->distinct(673)])->assertStatus(201);

        $this->api(['handle' => $this->distinct(674)])
            ->assertStatus(400)
            ->assertJsonPath('error.details.errors.0.path', ['handle']);
        $this->assertSame(1, Entry::query()->count());
    }

    public function test_the_admin_form_takes_a_value_at_its_bound_and_refuses_one_past_it(): void
    {
        $this->actingAs($this->admin(), 'admin');
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

    public function test_the_mcp_tools_refuse_a_value_its_capped_column_cannot_hold(): void
    {
        $owner = $this->admin();
        $made = $this->mcp($owner, 'create_entry', ['data' => ['handle' => $this->distinct(673)]]);
        $this->assertArrayNotHasKey('isError', $made);
        $documentId = $made['structuredContent']['data']['documentId'] ?? $made['structuredContent']['documentId'];

        // handle is bounded at 1000 characters, its unique column capped at 673: refused as the
        // server refuses any argument its input schema does not allow, before anything is written.
        $refused = $this->mcp($owner, 'create_entry', ['data' => ['handle' => $this->distinct(674)]]);
        $this->assertTrue($refused['isError'] ?? false);
        $this->assertStringStartsWith('Input validation error: Invalid arguments for tool create_entry:', $refused['content'][0]['text']);
        $this->assertStringContainsString('<=673 characters', $refused['content'][0]['text']);

        $unchanged = $this->mcp($owner, 'update_entry', ['documentId' => $documentId, 'data' => ['handle' => $this->distinct(674)]]);
        $this->assertTrue($unchanged['isError'] ?? false);
        $this->assertStringContainsString('<=673 characters', $unchanged['content'][0]['text']);
        $this->assertSame($this->distinct(673), Entry::query()->sole()->handle);
    }
}
