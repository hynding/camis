<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\ApiTokens\Pages\CreateApiToken;
use App\Filament\Resources\ApiTokens\Pages\EditApiToken;
use App\Filament\Resources\ApiTokens\Pages\ListApiTokens;
use App\Models\AdminUser;
use App\Models\Note;
use App\Models\StrapiApiToken;
use App\Models\User;
use App\Support\StrapiApiTokens;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The generated API tokens beyond what token-vectors.json reaches: the admin's API Tokens page,
 * a token's lifespan and its hourly last use, rows a role's condition hides, and the session
 * routes in refresh mode. CI copies this into the scaffolded app's tests/Feature.
 */
class ApiTokensTest extends TestCase
{
    use RefreshDatabase;

    private function login(array $permissions): AdminUser
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        foreach ($permissions as $permission) {
            \Spatie\Permission\Models\Permission::findOrCreate($permission);
        }
        $user = AdminUser::forceCreate(['firstname' => 'Admin', 'email' => 'admin@example.test', 'is_active' => true]);
        $user->givePermissionTo($permissions);
        $this->actingAs($user, 'admin');
        Filament::setCurrentPanel(Filament::getPanel('admin'));

        return $user;
    }

    /** A request with the token alone, as a client of the API sends it. */
    private function asClient(string $key): static
    {
        $this->app['auth']->forgetGuards();

        return $this->withHeader('Authorization', 'Bearer '.$key);
    }

    public function test_a_token_made_on_the_admin_page_reads_but_does_not_write(): void
    {
        $this->login(['user.update']);
        Livewire::test(CreateApiToken::class)
            ->fillForm(['name' => 'site', 'description' => 'the public site', 'type' => 'read-only', 'lifespan' => '604800000'])
            ->call('create')
            ->assertHasNoFormErrors()
            ->assertNotified('Copy your API token');

        $token = StrapiApiToken::where('name', 'site')->sole();
        $key = StrapiApiTokens::reveal($token);
        $this->assertSame(256, strlen((string) $key));
        $this->assertSame(StrapiApiTokens::hash((string) $key), $token->access_key);
        $this->assertTrue($token->expires_at->between(now()->addDays(7)->subMinute(), now()->addDays(7)));

        $this->asClient((string) $key)->getJson('/api/books')->assertOk();
        $this->asClient((string) $key)->postJson('/api/books', ['data' => ['title' => 'Dune']])->assertForbidden();
    }

    public function test_a_custom_token_needs_an_action(): void
    {
        $this->login(['user.update']);
        Livewire::test(CreateApiToken::class)
            ->fillForm(['name' => 'empty', 'type' => 'custom', 'permissions' => []])
            ->call('create')
            ->assertHasFormErrors(['permissions' => 'required']);

        Livewire::test(CreateApiToken::class)
            ->fillForm(['name' => 'lister', 'type' => 'custom', 'permissions' => ['api::book.book.find']])
            ->call('create')
            ->assertHasNoFormErrors();
        $this->assertSame(['api::book.book.find'], StrapiApiToken::where('name', 'lister')->sole()->permissions);
        $this->assertSame('book: findOne', StrapiApiTokens::actions()['api::book.book.findOne']);
    }

    public function test_regenerating_a_token_refuses_its_old_key(): void
    {
        $this->login(['user.update']);
        $made = StrapiApiTokens::create(['name' => 'ci', 'type' => 'full-access']);

        Livewire::test(EditApiToken::class, ['record' => $made['token']->getRouteKey()])
            ->callAction('regenerate')
            ->assertNotified('Copy your API token');

        $this->asClient($made['accessKey'])->getJson('/api/books')
            ->assertUnauthorized()->assertJsonPath('error.message', 'Missing or invalid credentials');
        $this->asClient((string) StrapiApiTokens::reveal($made['token']->refresh()))->getJson('/api/books')->assertOk();
    }

    public function test_the_tokens_are_out_of_reach_without_the_grant_to_change_accounts(): void
    {
        $this->login(['user.read']);
        Livewire::test(ListApiTokens::class)->assertForbidden();
        Livewire::test(CreateApiToken::class)->assertForbidden();
    }

    public function test_a_token_records_its_use_at_most_hourly(): void
    {
        $made = StrapiApiTokens::create(['name' => 'site']);
        $this->asClient($made['accessKey'])->getJson('/api/books')->assertOk();
        $first = $made['token']->refresh()->last_used_at;
        $this->assertNotNull($first);

        $this->travel(30)->minutes();
        $this->asClient($made['accessKey'])->getJson('/api/books')->assertOk();
        $this->assertEquals($first, $made['token']->refresh()->last_used_at);

        $this->travel(2)->hours();
        $this->asClient($made['accessKey'])->getJson('/api/books')->assertOk();
        $this->assertTrue($made['token']->refresh()->last_used_at->gt($first));
    }

    public function test_a_token_expires_at_the_end_of_its_lifespan(): void
    {
        $made = StrapiApiTokens::create(['name' => 'week', 'lifespan' => 7 * 86400000]);
        $this->travel(6)->days();
        $this->asClient($made['accessKey'])->getJson('/api/books')->assertOk();

        $this->travel(2)->days();
        $this->asClient($made['accessKey'])->getJson('/api/books')
            ->assertUnauthorized()->assertJsonPath('error.message', 'Token expired');
    }

    public function test_a_token_reads_rows_a_role_condition_hides_and_only_types_it_was_given(): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $owner = User::factory()->create(['username' => 'owner']);
        $note = new Note(['record_id' => 'n1', 'text' => 'mine', 'occurred_at' => now()]);
        $note->owner_id = $owner->id;
        $note->save();

        $full = StrapiApiTokens::create(['name' => 'full', 'type' => 'full-access']);
        $this->asClient($full['accessKey'])->getJson('/api/notes')->assertOk()->assertJsonPath('data.0.text', 'mine');

        $author = $this->asClient($full['accessKey'])->postJson('/api/authors', ['data' => ['name' => 'Frank Herbert']])->json('data.documentId');
        $this->asClient($full['accessKey'])->postJson('/api/books', ['data' => ['title' => 'Dune', 'author' => $author]])->assertCreated();

        // After the full-access token's requests, in the same process.
        $books = StrapiApiTokens::create(['name' => 'books', 'type' => 'custom', 'permissions' => ['api::book.book.find']]);
        $this->asClient($books['accessKey'])->getJson('/api/notes')->assertForbidden();
        $this->asClient($books['accessKey'])->getJson('/api/books?populate=author')
            ->assertOk()->assertJsonPath('data.0.title', 'Dune')->assertJsonMissingPath('data.0.author');
    }

    public function test_a_token_has_no_sessions_of_its_own(): void
    {
        config(['camis.users_permissions.jwt_management' => 'refresh']);
        $made = StrapiApiTokens::create(['name' => 'full', 'type' => 'full-access']);

        $this->asClient($made['accessKey'])->postJson('/api/auth/logout')
            ->assertUnauthorized()->assertJsonPath('error.message', 'Missing authentication');
        $this->asClient($made['accessKey'])->getJson('/api/auth/sessions')
            ->assertUnauthorized()->assertJsonPath('error.message', 'Missing authentication');
    }

    public function test_a_session_is_not_mistaken_for_a_token(): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $user = User::factory()->create(['username' => 'reader']);
        $user->assignRole('authenticated');
        $jwt = $user->createToken('api')->plainTextToken;

        $this->asClient($jwt)->getJson('/api/users/me')->assertOk()->assertJsonPath('username', 'reader');
    }

    public function test_a_token_holding_the_actions_reads_the_roles_and_their_permissions(): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        User::factory()->create(['username' => 'member'])->assignRole('authenticated');
        $full = StrapiApiTokens::create(['name' => 'full', 'type' => 'full-access']);

        $roles = $this->asClient($full['accessKey'])->getJson('/api/users-permissions/roles')->assertOk()->json('roles');
        $types = array_column($roles, 'type');
        $this->assertContains('authenticated', $types);
        $this->assertContains('public', $types);
        $this->assertSame([], array_values(array_intersect($types, AdminUser::adminRoles())), 'the admin\'s roles are apart, as in Strapi');
        $authenticated = $roles[array_search('authenticated', $types, true)];
        $this->assertSame(['Authenticated', 'Default role given to authenticated user.', 1], [$authenticated['name'], $authenticated['description'], $authenticated['nb_users']]);

        $role = $this->asClient($full['accessKey'])->getJson('/api/users-permissions/roles/'.$authenticated['id'])->assertOk()->json('role');
        $this->assertSame(['enabled' => true, 'policy' => ''], $role['permissions']['api::book']['controllers']['book']['find']);
        $public = $roles[array_search('public', $types, true)];
        $this->asClient($full['accessKey'])->getJson('/api/users-permissions/roles/'.$public['id'])
            ->assertOk()->assertJsonPath('role.permissions.api::book.controllers.book.create.enabled', false);
        $this->asClient($full['accessKey'])->getJson('/api/users-permissions/roles/999999')->assertNotFound();
        $this->asClient($full['accessKey'])->getJson('/api/users-permissions/permissions')
            ->assertOk()->assertJsonPath('permissions.plugin::users-permissions.controllers.role.find.enabled', false);

        // The grants are the IR's, rebuilt on every build: no write is taken, whatever the token.
        $this->asClient($full['accessKey'])->postJson('/api/users-permissions/roles', ['name' => 'Editor'])->assertForbidden();
        $this->asClient($full['accessKey'])->deleteJson('/api/users-permissions/roles/'.$public['id'])->assertForbidden();

        $reader = StrapiApiTokens::create(['name' => 'reader', 'type' => 'read-only']);
        $this->asClient($reader['accessKey'])->getJson('/api/users-permissions/roles')->assertOk();
        $this->asClient($reader['accessKey'])->getJson('/api/users-permissions/permissions')->assertForbidden();
        $books = StrapiApiTokens::create(['name' => 'books', 'type' => 'custom', 'permissions' => ['api::book.book.find']]);
        $this->asClient($books['accessKey'])->getJson('/api/users-permissions/roles')->assertForbidden();
    }

    public function test_a_session_cannot_read_the_roles(): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $user = User::factory()->create(['username' => 'reader']);
        $user->assignRole('authenticated');

        $this->asClient($user->createToken('api')->plainTextToken)->getJson('/api/users-permissions/roles')->assertForbidden();
        $this->app['auth']->forgetGuards();
        $this->withHeaders(['Authorization' => ''])->getJson('/api/users-permissions/roles')->assertForbidden();
    }

    /** Strapi keeps milliseconds, so two writes within a second still sort apart by updatedAt. */
    public function test_timestamps_keep_their_milliseconds(): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $full = StrapiApiTokens::create(['name' => 'full', 'type' => 'full-access']);
        \Illuminate\Support\Carbon::setTestNow('2026-03-04 05:06:07.120');
        $this->asClient($full['accessKey'])->postJson('/api/books', ['data' => ['title' => 'First']])
            ->assertCreated()->assertJsonPath('data.createdAt', '2026-03-04T05:06:07.120Z');
        \Illuminate\Support\Carbon::setTestNow('2026-03-04 05:06:07.450');
        $this->asClient($full['accessKey'])->postJson('/api/books', ['data' => ['title' => 'Second', 'releasedAt' => '2026-01-02T03:04:05.678Z']])
            ->assertCreated()->assertJsonPath('data.releasedAt', '2026-01-02T03:04:05.678Z');
        \Illuminate\Support\Carbon::setTestNow();

        $this->asClient($full['accessKey'])->getJson('/api/books?sort=updatedAt:desc&fields[0]=title')
            ->assertOk()->assertJsonPath('data.0.title', 'Second')->assertJsonPath('data.1.title', 'First');
        $this->asClient($full['accessKey'])->getJson('/api/books?filters[createdAt][$eq]=2026-03-04T05:06:07.120Z&fields[0]=title')
            ->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.title', 'First');
    }
}
