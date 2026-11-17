<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\AdminTokens\Pages\CreateAdminToken;
use App\Filament\Resources\AdminTokens\Pages\EditAdminToken;
use App\Filament\Resources\AdminTokens\Pages\ListAdminTokens;
use App\Models\AdminUser;
use App\Models\StrapiAdminToken;
use App\Models\StrapiApiToken;
use App\Support\StrapiAdminTokens;
use App\Support\StrapiApiTokens;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Livewire\Livewire;
use Spatie\Permission\Models\Permission;
use Spatie\Permission\Models\Role;
use Tests\TestCase;

/**
 * Strapi 5's admin tokens (Phase 83): a key that acts in the admin as the account that made it,
 * with only the permissions it was given and never more than its owner holds. The admin API's
 * bodies and errors are strapi-php's (recorded from its /admin/admin-tokens). CI copies this into
 * the scaffolded app's tests/Feature.
 */
class AdminTokensTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
    }

    /** @param list<string> $permissions */
    private function admin(string $email = 'ada@example.test', array $permissions = ['user.update', 'book.read', 'book.update', 'post.publish']): AdminUser
    {
        $admin = AdminUser::forceCreate(['firstname' => 'Ada', 'lastname' => 'Admin', 'email' => $email, 'password' => 'Admin-pass-1', 'is_active' => true]);
        foreach ($permissions as $permission) {
            Permission::findOrCreate($permission);
        }
        $admin->givePermissionTo($permissions);

        return $admin;
    }

    private function signIn(string $email = 'ada@example.test'): string
    {
        $this->app['auth']->forgetGuards();

        return (string) $this->postJson('/admin/login', ['email' => $email, 'password' => 'Admin-pass-1'])->assertOk()->json('data.token');
    }

    /** @param array<string, mixed> $body */
    private function asAdmin(string $token, string $method, string $uri, array $body = []): \Illuminate\Testing\TestResponse
    {
        $this->app['auth']->forgetGuards();

        return $this->json($method, $uri, $body, ['Authorization' => 'Bearer '.$token]);
    }

    private function onPanel(AdminUser $admin): void
    {
        $this->actingAs($admin, 'admin');
        Filament::setCurrentPanel(Filament::getPanel('admin'));
    }

    public function test_the_admin_api_makes_a_token_with_strapis_bodies(): void
    {
        $this->admin();
        $jwt = $this->signIn();

        $made = $this->asAdmin($jwt, 'POST', '/admin/admin-tokens', [
            'name' => 'reader',
            'description' => 'reads',
            'lifespan' => 604800000,
            'adminPermissions' => [
                ['action' => 'plugin::content-manager.explorer.read', 'subject' => 'api::book.book', 'properties' => ['fields' => ['title']], 'conditions' => []],
                // The owner may not create books: Strapi's ceiling drops what the owner lacks.
                ['action' => 'plugin::content-manager.explorer.create', 'subject' => 'api::book.book', 'properties' => [], 'conditions' => []],
                // No such permission here (a settings action): dropped too.
                ['action' => 'admin::webhooks.read', 'subject' => null, 'properties' => [], 'conditions' => []],
            ],
        ])->assertCreated();

        $made->assertJsonPath('data.kind', 'admin')
            ->assertJsonPath('data.name', 'reader')
            ->assertJsonPath('data.description', 'reads')
            ->assertJsonPath('data.type', 'read-only')
            ->assertJsonPath('data.lifespan', '604800000')
            ->assertJsonPath('data.lastUsedAt', null)
            ->assertJsonPath('data.adminUserOwner.email', 'ada@example.test')
            ->assertJsonPath('data.adminUserOwner.firstname', 'Ada')
            ->assertJsonPath('data.adminPermissions.0.action', 'plugin::content-manager.explorer.read')
            ->assertJsonPath('data.adminPermissions.0.subject', 'api::book.book')
            ->assertJsonCount(1, 'data.adminPermissions');
        $this->assertSame(256, strlen((string) $made->json('data.accessKey')));
        $this->assertSame(['book.read'], StrapiAdminToken::where('name', 'reader')->sole()->admin_permissions);

        // An admin token never shows among the content API tokens, nor works as one.
        $this->asAdmin($jwt, 'GET', '/admin/api-tokens')->assertOk()->assertJsonCount(0, 'data');
        $this->app['auth']->forgetGuards();
        $this->withHeader('Authorization', 'Bearer '.$made->json('data.accessKey'))->getJson('/api/books')
            ->assertUnauthorized();
    }

    public function test_the_admin_api_refuses_what_strapi_refuses(): void
    {
        $this->admin();
        $jwt = $this->signIn();
        $this->asAdmin($jwt, 'POST', '/admin/admin-tokens', ['name' => 'x', 'type' => 'custom'])
            ->assertStatus(400)->assertJsonPath('error.name', 'BadRequestError')->assertJsonPath('error.message', 'Type is not allowed for admin tokens');
        $this->asAdmin($jwt, 'POST', '/admin/admin-tokens', ['name' => 'x', 'permissions' => []])
            ->assertStatus(400)->assertJsonPath('error.message', 'Permissions are not allowed for admin tokens');
        $this->asAdmin($jwt, 'POST', '/admin/admin-tokens', [])
            ->assertStatus(400)->assertJsonPath('error.name', 'ValidationError')->assertJsonPath('error.message', '2 errors occurred');
        StrapiApiTokens::create(['name' => 'taken']);
        $this->asAdmin($jwt, 'POST', '/admin/admin-tokens', ['name' => 'taken'])
            ->assertStatus(400)->assertJsonPath('error.name', 'ApplicationError')->assertJsonPath('error.message', 'Name already taken');
        $this->asAdmin($jwt, 'GET', '/admin/admin-tokens/99')
            ->assertNotFound()->assertJsonPath('error.message', 'API Token not found');
    }

    public function test_the_admin_api_lists_gets_updates_regenerates_and_revokes(): void
    {
        $ada = $this->admin();
        $jwt = $this->signIn();
        $made = StrapiAdminTokens::create($ada, ['name' => 'mine', 'admin_permissions' => ['book.read']]);
        $id = $made['token']->id;

        $this->asAdmin($jwt, 'GET', '/admin/admin-tokens')->assertOk()
            ->assertJsonPath('data.0.name', 'mine')->assertJsonPath('data.0.adminUserOwner.email', 'ada@example.test');
        // Its owner reads the key again; another account would not.
        $this->asAdmin($jwt, 'GET', "/admin/admin-tokens/{$id}")->assertOk()
            ->assertJsonPath('data.accessKey', $made['accessKey']);
        $this->asAdmin($jwt, 'PUT', "/admin/admin-tokens/{$id}", ['description' => 'changed', 'adminPermissions' => [
            ['action' => 'plugin::content-manager.explorer.update', 'subject' => 'api::book.book'],
        ]])->assertOk()->assertJsonPath('data.description', 'changed')
            ->assertJsonPath('data.adminPermissions.0.action', 'plugin::content-manager.explorer.update');

        $regenerated = $this->asAdmin($jwt, 'POST', "/admin/admin-tokens/{$id}/regenerate")->assertCreated();
        $this->assertSame(['accessKey', 'id', 'kind', 'name'], collect($regenerated->json('data'))->keys()->sort()->values()->all());
        $this->assertNull(StrapiAdminTokens::authenticate($made['accessKey']));
        $this->assertNotNull(StrapiAdminTokens::authenticate((string) $regenerated->json('data.accessKey')));

        $this->asAdmin($jwt, 'GET', "/admin/admin-tokens/{$id}/owner-permissions")->assertOk()
            ->assertJsonFragment(['action' => 'plugin::content-manager.explorer.publish', 'subject' => 'api::post.post']);

        $this->asAdmin($jwt, 'DELETE', "/admin/admin-tokens/{$id}")->assertOk()->assertJsonPath('data.name', 'mine');
        $this->asAdmin($jwt, 'GET', "/admin/admin-tokens/{$id}")->assertNotFound();
    }

    public function test_an_account_sees_only_its_own_tokens_and_only_its_owner_regenerates(): void
    {
        $ada = $this->admin();
        $bob = $this->admin('bob@example.test');
        $adas = StrapiAdminTokens::create($ada, ['name' => 'adas']);
        StrapiAdminTokens::create($bob, ['name' => 'bobs']);
        $jwt = $this->signIn('bob@example.test');

        $this->asAdmin($jwt, 'GET', '/admin/admin-tokens')->assertOk()
            ->assertJsonCount(1, 'data')->assertJsonPath('data.0.name', 'bobs');
        $this->asAdmin($jwt, 'GET', "/admin/admin-tokens/{$adas['token']->id}")->assertNotFound();
        $this->asAdmin($jwt, 'PUT', "/admin/admin-tokens/{$adas['token']->id}", ['description' => 'x'])->assertForbidden();

        // A super-admin manages every token, yet only an owner regenerates one.
        Role::findOrCreate('super-admin');
        $bob->assignRole('super-admin');
        $this->asAdmin($jwt, 'GET', '/admin/admin-tokens')->assertOk()->assertJsonCount(2, 'data');
        $this->asAdmin($jwt, 'GET', "/admin/admin-tokens/{$adas['token']->id}")->assertOk()->assertJsonMissingPath('data.accessKey');
        $this->asAdmin($jwt, 'POST', "/admin/admin-tokens/{$adas['token']->id}/regenerate")->assertForbidden();
    }

    public function test_a_token_does_what_it_was_given_while_its_owner_still_may(): void
    {
        $ada = $this->admin();
        $made = StrapiAdminTokens::create($ada, ['name' => 'editor', 'admin_permissions' => ['book.read', 'book.update']]);
        [$token, $owner] = StrapiAdminTokens::authenticate($made['accessKey']) ?? [null, null];
        $this->assertNotNull($token);
        $this->assertTrue(StrapiAdminTokens::allows($token, $owner, 'book.update'));
        $this->assertFalse(StrapiAdminTokens::allows($token, $owner, 'post.publish'), 'the owner holds it, the token was not given it');

        $ada->revokePermissionTo('book.update');
        [$token, $owner] = StrapiAdminTokens::authenticate($made['accessKey']) ?? [null, null];
        $this->assertFalse(StrapiAdminTokens::allows($token, $owner, 'book.update'), 'the owner lost it, so the token did');
        $this->assertNotNull($token->refresh()->last_used_at);

        $ada->forceFill(['blocked' => true])->save();
        $this->assertNull(StrapiAdminTokens::authenticate($made['accessKey']));
        $ada->forceFill(['blocked' => false, 'is_active' => false])->save();
        $this->assertNull(StrapiAdminTokens::authenticate($made['accessKey']));
    }

    public function test_a_token_expires_and_goes_with_its_owner(): void
    {
        $ada = $this->admin();
        $week = StrapiAdminTokens::create($ada, ['name' => 'week', 'lifespan' => 7 * 86400000]);
        $this->travel(8)->days();
        $this->assertNull(StrapiAdminTokens::authenticate($week['accessKey']));

        $ada->delete();
        $this->assertSame(0, StrapiAdminToken::query()->count());
    }

    public function test_the_admin_tokens_page_offers_only_the_accounts_own_permissions(): void
    {
        $ada = $this->admin();
        $this->onPanel($ada);
        $offered = StrapiAdminTokens::offered($ada);
        $this->assertArrayHasKey('book.update', array_merge(...array_values($offered)));
        $this->assertArrayNotHasKey('book.create', array_merge(...array_values($offered)));

        Livewire::test(CreateAdminToken::class)
            ->fillForm(['name' => 'agent', 'description' => 'an MCP client', 'lifespan' => '604800000', 'admin_permissions' => ['book.read', 'book.create']])
            ->call('create')
            ->assertHasFormErrors(['admin_permissions']);
        Livewire::test(CreateAdminToken::class)
            ->fillForm(['name' => 'agent', 'description' => 'an MCP client', 'lifespan' => '604800000', 'admin_permissions' => ['book.read']])
            ->call('create')
            ->assertHasNoFormErrors()
            ->assertNotified('Copy your admin token');

        $token = StrapiAdminToken::where('name', 'agent')->sole();
        $this->assertSame($ada->id, $token->admin_user_owner_id);
        $this->assertSame(['book.read'], $token->admin_permissions);
        $this->assertSame(0, StrapiApiToken::query()->count());
        Livewire::test(ListAdminTokens::class)->assertCanSeeTableRecords([$token]);
        Livewire::test(EditAdminToken::class, ['record' => $token->getRouteKey()])
            ->callAction('regenerate')
            ->assertNotified('Copy your admin token');
    }

    public function test_the_admin_tokens_page_is_out_of_reach_without_the_grant_to_change_accounts(): void
    {
        $this->onPanel($this->admin(permissions: ['book.read']));
        Livewire::test(ListAdminTokens::class)->assertForbidden();
        Livewire::test(CreateAdminToken::class)->assertForbidden();
    }

    public function test_strapis_admin_tokens_come_over_with_their_owner(): void
    {
        $ada = $this->admin();
        $source = tempnam(sys_get_temp_dir(), 'strapi').'.db';
        $pdo = new \PDO('sqlite:'.$source);
        $pdo->exec(<<<'SQL'
            CREATE TABLE admin_users (id INTEGER PRIMARY KEY, email TEXT);
            INSERT INTO admin_users VALUES (1, 'ada@example.test'), (2, 'gone@example.test');
            CREATE TABLE strapi_api_tokens (id INTEGER PRIMARY KEY, document_id TEXT, name TEXT, description TEXT, kind TEXT, type TEXT, access_key TEXT, encrypted_key TEXT, last_used_at TEXT, expires_at TEXT, lifespan INTEGER, created_at TEXT, updated_at TEXT);
            INSERT INTO strapi_api_tokens VALUES (1, 'd1', 'agent', 'an MCP client', 'admin', NULL, 'hashed-1', NULL, NULL, NULL, NULL, '2026-11-01 10:00:00', '2026-11-01 10:00:00');
            INSERT INTO strapi_api_tokens VALUES (2, 'd2', 'orphan', '', 'admin', NULL, 'hashed-2', NULL, NULL, NULL, NULL, '2026-11-01 10:00:00', '2026-11-01 10:00:00');
            CREATE TABLE strapi_api_tokens_admin_user_owner_lnk (id INTEGER PRIMARY KEY, api_token_id INTEGER, user_id INTEGER);
            INSERT INTO strapi_api_tokens_admin_user_owner_lnk VALUES (1, 1, 1), (2, 2, 2);
            CREATE TABLE admin_permissions (id INTEGER PRIMARY KEY, action TEXT, subject TEXT);
            INSERT INTO admin_permissions VALUES (1, 'plugin::content-manager.explorer.read', 'api::book.book'), (2, 'plugin::content-manager.explorer.delete', 'api::book.book');
            CREATE TABLE admin_permissions_api_token_lnk (id INTEGER PRIMARY KEY, permission_id INTEGER, api_token_id INTEGER);
            INSERT INTO admin_permissions_api_token_lnk VALUES (1, 1, 1), (2, 2, 1);
            CREATE TABLE strapi_api_token_permissions (id INTEGER PRIMARY KEY, action TEXT);
            CREATE TABLE strapi_api_token_permissions_token_lnk (id INTEGER PRIMARY KEY, api_token_permission_id INTEGER, api_token_id INTEGER);
            CREATE TABLE strapi_transfer_tokens (id INTEGER PRIMARY KEY, name TEXT, description TEXT, access_key TEXT, last_used_at TEXT, expires_at TEXT, lifespan INTEGER, created_at TEXT, updated_at TEXT);
            SQL);

        $this->artisan('strapi:import-tokens', ['--database' => $source, '--force' => true])->assertSuccessful();

        $agent = StrapiAdminToken::where('name', 'agent')->sole();
        $this->assertSame($ada->id, $agent->admin_user_owner_id);
        $this->assertSame('hashed-1', DB::table('strapi_api_tokens')->where('name', 'agent')->value('access_key'));
        // The delete it was given came over; the owner does not hold it, so the token cannot use it.
        $this->assertSame(['book.delete', 'book.read'], collect($agent->admin_permissions)->sort()->values()->all());
        $this->assertFalse(StrapiAdminToken::where('name', 'orphan')->exists(), 'no account here owns it');
    }
}
