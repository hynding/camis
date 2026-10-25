<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\TransferTokens\Pages\CreateTransferToken;
use App\Filament\Resources\TransferTokens\Pages\EditTransferToken;
use App\Filament\Resources\TransferTokens\Pages\ListTransferTokens;
use App\Models\StrapiTransferToken;
use App\Models\User;
use App\Support\StrapiTransferTokens;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The generated transfer tokens beyond what transfer-token-vectors.json reaches: the admin's
 * Transfer Tokens page, a token's lifespan and its hourly last use. CI copies this into the
 * scaffolded app's tests/Feature.
 */
class TransferTokensTest extends TestCase
{
    use RefreshDatabase;

    private function login(array $permissions): User
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        foreach ($permissions as $permission) {
            \Spatie\Permission\Models\Permission::findOrCreate($permission);
        }
        $user = User::factory()->create(['username' => 'admin']);
        $user->givePermissionTo($permissions);
        $this->actingAs($user);
        Filament::setCurrentPanel(Filament::getPanel('admin'));

        return $user;
    }

    /** A request with the token alone, as `strapi transfer` sends it. */
    private function asClient(string $key): static
    {
        $this->app['auth']->forgetGuards();

        return $this->withHeader('Authorization', 'Bearer '.$key);
    }

    public function test_a_token_made_on_the_admin_page_is_kept_only_as_a_hash(): void
    {
        $this->login(['user.update']);
        Livewire::test(CreateTransferToken::class)
            ->fillForm(['name' => 'staging', 'permissions' => ['pull'], 'lifespan' => '604800000'])
            ->call('create')
            ->assertHasNoFormErrors()
            ->assertNotified('Copy your transfer token');

        $token = StrapiTransferToken::where('name', 'staging')->sole();
        $this->assertSame(['pull'], $token->permissions);
        $this->assertSame(128, strlen($token->access_key));
        $this->assertTrue($token->expires_at->between(now()->addDays(7)->subMinute(), now()->addDays(7)));
        $this->assertArrayNotHasKey('access_key', $token->toArray());
    }

    public function test_a_token_needs_push_or_pull(): void
    {
        $this->login(['user.update']);
        Livewire::test(CreateTransferToken::class)
            ->fillForm(['name' => 'none', 'permissions' => []])
            ->call('create')
            ->assertHasFormErrors(['permissions' => 'required']);
        $this->expectException(\InvalidArgumentException::class);
        StrapiTransferTokens::create(['name' => 'odd', 'permissions' => ['delete']]);
    }

    public function test_regenerating_a_token_refuses_its_old_key(): void
    {
        $this->login(['user.update']);
        $made = StrapiTransferTokens::create(['name' => 'ci', 'permissions' => ['push']]);

        Livewire::test(EditTransferToken::class, ['record' => $made['token']->getRouteKey()])
            ->callAction('regenerate')
            ->assertNotified('Copy your transfer token');

        $this->asClient($made['accessKey'])->getJson('/admin/transfer/runner/push')
            ->assertUnauthorized()->assertJsonPath('error.message', 'Missing or invalid credentials');
    }

    public function test_editing_a_token_keeps_its_key_and_changes_its_permissions(): void
    {
        $this->login(['user.update']);
        $made = StrapiTransferTokens::create(['name' => 'ci', 'permissions' => ['push']]);

        Livewire::test(EditTransferToken::class, ['record' => $made['token']->getRouteKey()])
            ->fillForm(['description' => null, 'permissions' => ['push', 'pull']])
            ->call('save')
            ->assertHasNoFormErrors();

        $this->asClient($made['accessKey'])->getJson('/admin/transfer/runner/pull')
            ->assertStatus(501)->assertJsonPath('error.name', 'NotImplementedError');
    }

    public function test_the_tokens_are_out_of_reach_without_the_grant_to_change_accounts(): void
    {
        $this->login(['user.read']);
        Livewire::test(ListTransferTokens::class)->assertForbidden();
        Livewire::test(CreateTransferToken::class)->assertForbidden();
    }

    public function test_a_token_records_its_use_at_most_hourly(): void
    {
        $made = StrapiTransferTokens::create(['name' => 'site', 'permissions' => ['pull']]);
        $this->asClient($made['accessKey'])->getJson('/admin/transfer/runner/pull')->assertStatus(501);
        $first = $made['token']->refresh()->last_used_at;
        $this->assertNotNull($first);

        $this->travel(30)->minutes();
        $this->asClient($made['accessKey'])->getJson('/admin/transfer/runner/pull')->assertStatus(501);
        $this->assertEquals($first, $made['token']->refresh()->last_used_at);

        $this->travel(2)->hours();
        $this->asClient($made['accessKey'])->getJson('/admin/transfer/runner/pull')->assertStatus(501);
        $this->assertTrue($made['token']->refresh()->last_used_at->gt($first));
    }

    public function test_a_token_expires_at_the_end_of_its_lifespan(): void
    {
        $made = StrapiTransferTokens::create(['name' => 'week', 'permissions' => ['push'], 'lifespan' => 7 * 86400000]);
        $this->travel(6)->days();
        $this->asClient($made['accessKey'])->getJson('/admin/transfer/runner/push')->assertStatus(501);

        $this->travel(2)->days();
        $this->asClient($made['accessKey'])->getJson('/admin/transfer/runner/push')
            ->assertUnauthorized()->assertJsonPath('error.message', 'Token expired');
    }
}
