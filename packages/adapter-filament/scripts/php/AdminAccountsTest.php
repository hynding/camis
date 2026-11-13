<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\AdminUsers\Pages\CreateAdminUser;
use App\Filament\Resources\AdminUsers\Pages\ListAdminUsers;
use App\Models\AdminUser;
use App\Models\StrapiApiToken;
use App\Models\User;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Livewire\Livewire;
use Spatie\Permission\Models\Permission;
use Tests\TestCase;

/**
 * Admin accounts apart from the API's users, as Strapi keeps admin_users apart from up_users: the
 * admin guard (the panel's) signs in an AdminUser only, /api/users never lists one, Strapi's admin
 * API signs a client in and makes it API tokens, Settings › Admin users manages the accounts, and
 * strapi:import-admins brings a Strapi project's over. CI copies this into the scaffolded app's
 * tests/Feature.
 */
class AdminAccountsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
    }

    /** @param list<string> $permissions */
    private function admin(string $email = 'admin@example.test', array $permissions = ['user.update'], bool $active = true): AdminUser
    {
        $admin = AdminUser::forceCreate(['firstname' => 'Ada', 'lastname' => 'Admin', 'email' => $email, 'password' => 'Admin-pass-1', 'is_active' => $active]);
        foreach ($permissions as $permission) {
            Permission::findOrCreate($permission);
        }
        $admin->givePermissionTo($permissions);

        return $admin;
    }

    private function signIn(string $email = 'admin@example.test', string $password = 'Admin-pass-1'): string
    {
        $this->app['auth']->forgetGuards();

        return (string) $this->postJson('/admin/login', ['email' => $email, 'password' => $password])->assertOk()->json('data.token');
    }

    /** @param array<string, mixed> $body */
    private function asAdmin(string $token, string $method, string $uri, array $body = []): \Illuminate\Testing\TestResponse
    {
        $this->app['auth']->forgetGuards();

        return $this->json($method, $uri, $body, ['Authorization' => 'Bearer '.$token]);
    }

    public function test_the_admin_panel_signs_in_an_admin_account_and_never_an_api_user(): void
    {
        $this->admin();
        User::factory()->create(['username' => 'reader', 'email' => 'reader@example.test', 'password' => Hash::make('Reader-pass-1')]);

        $this->assertSame('admin', Filament::getPanel('admin')->getAuthGuard());
        $this->assertSame(AdminUser::class, Auth::guard('admin')->getProvider()->getModel());
        $this->assertTrue(Auth::guard('admin')->validate(['email' => 'admin@example.test', 'password' => 'Admin-pass-1']));
        $this->assertFalse(Auth::guard('admin')->validate(['email' => 'reader@example.test', 'password' => 'Reader-pass-1']));
    }

    // Strapi's profile page: an admin picks an interface language among the admin's locales
    // (CAMIS_ADMIN_LOCALES, Strapi's admin config.locales), and the admin then speaks it.
    public function test_an_admin_picks_their_interface_language(): void
    {
        config(['camis-admin.locales' => ['en', 'fr']]);
        $admin = $this->admin();
        $this->actingAs($admin, 'admin');
        Filament::setCurrentPanel(Filament::getPanel('admin'));
        Livewire::test(\App\Filament\Pages\AdminProfile::class)
            ->assertFormFieldExists('prefered_language')
            ->fillForm(['prefered_language' => 'de'])
            ->call('save')
            ->assertHasFormErrors(['prefered_language']);
        Livewire::test(\App\Filament\Pages\AdminProfile::class)
            ->fillForm(['firstname' => 'Ada', 'prefered_language' => 'fr'])
            ->call('save')
            ->assertHasNoFormErrors();
        $this->assertSame('fr', $admin->refresh()->prefered_language);

        $this->get('/admin/profile')->assertOk()->assertSee('<html lang="fr"', false);
        $admin->forceFill(['prefered_language' => null])->save();
        $this->get('/admin/profile')->assertOk()->assertSee('<html lang="'.config('app.locale').'"', false);
    }

    public function test_an_admin_account_is_not_an_api_user(): void
    {
        $this->admin();
        $key = (string) $this->asAdmin($this->signIn(), 'POST', '/admin/api-tokens', ['name' => 'lister', 'type' => 'full-access'])->json('data.accessKey');

        $this->app['auth']->forgetGuards();
        $users = $this->getJson('/api/users', ['Authorization' => 'Bearer '.$key])->assertOk()->json();
        $this->assertNotContains('admin@example.test', array_column($users, 'email'));
    }

    public function test_init_tells_whether_an_admin_exists(): void
    {
        $this->getJson('/admin/init')->assertOk()->assertExactJson(['data' => ['uuid' => false, 'hasAdmin' => false, 'menuLogo' => null, 'authLogo' => null]]);
        $this->admin();
        $this->getJson('/admin/init')->assertOk()->assertJsonPath('data.hasAdmin', true);
    }

    public function test_a_sign_in_is_refused_as_strapi_refuses_it(): void
    {
        $this->admin();
        $this->admin('asleep@example.test', [], false);
        $refused = fn (array $body, string $message) => $this->postJson('/admin/login', $body)
            ->assertStatus(400)
            ->assertExactJson(['data' => null, 'error' => ['status' => 400, 'name' => 'ApplicationError', 'message' => $message, 'details' => []]]);

        $refused(['email' => 'admin@example.test'], 'Missing credentials');
        $refused(['email' => 'nobody@example.test', 'password' => 'Admin-pass-1'], 'Invalid credentials');
        $refused(['email' => 'admin@example.test', 'password' => 'wrong'], 'Invalid credentials');
        $refused(['email' => 'asleep@example.test', 'password' => 'Admin-pass-1'], 'User not active');
    }

    public function test_a_sign_in_returns_strapis_body_and_a_token_for_the_admin_api(): void
    {
        $admin = $this->admin();
        $session = $this->postJson('/admin/login', ['email' => 'Admin@Example.test', 'password' => 'Admin-pass-1'])->assertOk();
        $token = (string) $session->json('data.token');
        $this->assertSame($token, $session->json('data.accessToken'));
        $session->assertJsonPath('data.user.id', $admin->id)
            ->assertJsonPath('data.user.email', 'admin@example.test')
            ->assertJsonPath('data.user.firstname', 'Ada')
            ->assertJsonPath('data.user.isActive', true)
            ->assertJsonMissingPath('data.user.password');

        $this->asAdmin($token, 'GET', '/admin/users/me')->assertOk()->assertJsonPath('data.email', 'admin@example.test');
        $this->asAdmin('not-a-token', 'GET', '/admin/users/me')->assertStatus(401)->assertJsonPath('error.name', 'UnauthorizedError');

        // The token is the admin API's only: the content API does not take it.
        $this->app['auth']->forgetGuards();
        $this->getJson('/api/users/me', ['Authorization' => 'Bearer '.$token])->assertStatus(401);

        // Strapi's admin access token lasts 30 minutes.
        $this->travel(31)->minutes();
        $this->asAdmin($token, 'GET', '/admin/users/me')->assertStatus(401);
    }

    public function test_the_first_admin_registers_only_while_there_is_none(): void
    {
        $this->postJson('/admin/register-admin', ['email' => 'first@example.test', 'firstname' => 'First', 'password' => 'short'])
            ->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError')
            ->assertJsonPath('error.message', 'password must be at least 8 characters');

        // This project marks no role as an admin role, so there is no super admin role to give.
        $this->postJson('/admin/register-admin', ['email' => 'first@example.test', 'firstname' => 'First', 'password' => 'First-pass-1'])
            ->assertStatus(400)
            ->assertJsonPath('error.message', "Cannot register the first admin because the super admin role doesn't exist.");
        $this->assertFalse(AdminUser::query()->exists());
    }

    public function test_a_signed_in_admin_makes_reads_changes_and_revokes_api_tokens(): void
    {
        $this->admin();
        $token = $this->signIn();

        $made = $this->asAdmin($token, 'POST', '/admin/api-tokens', ['name' => 'site', 'description' => 'the site', 'type' => 'read-only', 'lifespan' => null])
            ->assertCreated()
            ->assertJsonPath('data.name', 'site')
            ->assertJsonPath('data.type', 'read-only')
            ->assertJsonPath('data.expiresAt', null);
        $id = (int) $made->json('data.id');
        $key = (string) $made->json('data.accessKey');
        $this->assertSame(256, strlen($key));

        $this->app['auth']->forgetGuards();
        $this->getJson('/api/books', ['Authorization' => 'Bearer '.$key])->assertOk();
        $this->app['auth']->forgetGuards();
        $this->postJson('/api/books', ['data' => ['title' => 'Dune']], ['Authorization' => 'Bearer '.$key])->assertForbidden();

        $this->asAdmin($token, 'POST', '/admin/api-tokens', ['name' => 'site', 'type' => 'read-only'])
            ->assertStatus(400)->assertJsonPath('error.message', 'Name already taken');
        $this->asAdmin($token, 'POST', '/admin/api-tokens', ['name' => 'empty', 'type' => 'custom', 'permissions' => []])
            ->assertStatus(400)->assertJsonPath('error.name', 'ValidationError');

        $this->asAdmin($token, 'GET', '/admin/api-tokens')->assertOk()
            ->assertJsonPath('data.0.name', 'site')
            ->assertJsonMissingPath('data.0.accessKey');
        $this->asAdmin($token, 'GET', "/admin/api-tokens/{$id}")->assertOk()->assertJsonPath('data.description', 'the site');
        $this->asAdmin($token, 'GET', '/admin/api-tokens/999')->assertNotFound()->assertJsonPath('error.message', 'API Token not found');
        $this->asAdmin($token, 'PUT', "/admin/api-tokens/{$id}", ['name' => 'website', 'type' => 'custom', 'permissions' => ['api::book.book.find']])
            ->assertOk()->assertJsonPath('data.name', 'website')->assertJsonPath('data.permissions', ['api::book.book.find']);

        $again = (string) $this->asAdmin($token, 'POST', "/admin/api-tokens/{$id}/regenerate")->assertCreated()->json('data.accessKey');
        $this->assertNotSame($key, $again);
        $this->app['auth']->forgetGuards();
        $this->getJson('/api/books', ['Authorization' => 'Bearer '.$key])->assertUnauthorized();

        $this->asAdmin($token, 'DELETE', "/admin/api-tokens/{$id}")->assertOk()->assertJsonPath('data.name', 'website');
        $this->assertFalse(StrapiApiToken::query()->exists());
        $this->app['auth']->forgetGuards();
        $this->getJson('/api/books', ['Authorization' => 'Bearer '.$again])->assertUnauthorized();
    }

    public function test_api_tokens_need_a_signed_in_admin_who_may_change_accounts(): void
    {
        $this->getJson('/admin/api-tokens')->assertUnauthorized()->assertJsonPath('error.message', 'Missing or invalid credentials');
        $this->admin('reader@example.test', []);
        $this->asAdmin($this->signIn('reader@example.test'), 'POST', '/admin/api-tokens', ['name' => 'nope', 'type' => 'full-access'])
            ->assertForbidden();
        $this->assertFalse(StrapiApiToken::query()->exists());
    }

    public function test_settings_admin_users_makes_an_admin_account_for_who_may_change_accounts(): void
    {
        $admin = $this->admin();
        $this->actingAs($admin, 'admin');
        Filament::setCurrentPanel(Filament::getPanel('admin'));
        Livewire::test(CreateAdminUser::class)
            ->fillForm(['firstname' => 'Grace', 'email' => 'Grace@Example.test', 'password' => 'Grace-pass-1', 'is_active' => true])
            ->call('create')
            ->assertHasNoFormErrors();
        $grace = AdminUser::query()->where('email', 'grace@example.test')->sole();
        $this->assertTrue(Hash::check('Grace-pass-1', (string) $grace->getAuthPassword()));
        $this->assertNotNull($grace->getAttribute('document_id'));
        $this->assertFalse(User::query()->where('email', 'grace@example.test')->exists());

        $this->actingAs($this->admin('reader@example.test', []), 'admin');
        Livewire::test(ListAdminUsers::class)->assertForbidden();
    }

    public function test_strapi_import_admins_keeps_each_accounts_password_and_reports_a_role_with_no_match(): void
    {
        $database = tempnam(sys_get_temp_dir(), 'strapi-admins');
        $pdo = new \PDO('sqlite:'.$database);
        $pdo->exec(<<<'SQL'
            CREATE TABLE admin_users (id INTEGER PRIMARY KEY, document_id TEXT, firstname TEXT, lastname TEXT, username TEXT, email TEXT, password TEXT, reset_password_token TEXT, registration_token TEXT, is_active BOOLEAN, blocked BOOLEAN, prefered_language TEXT, created_at BIGINT, updated_at BIGINT, published_at BIGINT, locale TEXT);
            CREATE TABLE admin_roles (id INTEGER PRIMARY KEY, document_id TEXT, name TEXT, code TEXT, description TEXT);
            CREATE TABLE admin_users_roles_lnk (id INTEGER PRIMARY KEY, user_id INTEGER, role_id INTEGER, role_ord REAL, user_ord REAL);
            INSERT INTO admin_roles VALUES (1, 'r1', 'Super Admin', 'strapi-super-admin', 'Super Admins can access and manage all features and settings.');
            SQL);
        // bcryptjs, which Strapi hashes with, writes $2a$.
        $hash = '$2a$'.substr(password_hash('Strapi-pass-1', PASSWORD_BCRYPT, ['cost' => 10]), 4);
        $insert = $pdo->prepare('INSERT INTO admin_users (id, document_id, firstname, lastname, email, password, is_active, blocked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1730000000000, 1730000000000)');
        $insert->execute([1, 'h3k2c9v8b7n6m5l4k3j2h1g0', 'Kim', 'Strapi', 'Kim@Example.test', $hash, 1]);
        $insert->execute([2, 'p0o9i8u7y6t5r4e3w2q1a2s3', 'Lee', null, 'lee@example.test', null, 0]);
        $pdo->exec('INSERT INTO admin_users_roles_lnk (user_id, role_id, role_ord, user_ord) VALUES (1, 1, 1, 1)');

        $this->artisan('strapi:import-admins', ['--database' => $database])
            ->expectsOutputToContain('kim@example.test: the Strapi admin role "Super Admin" has no admin role of that name here')
            ->expectsOutputToContain('lee@example.test: not active on Strapi')
            ->assertSuccessful();
        unlink($database);

        $kim = AdminUser::query()->where('email', 'kim@example.test')->sole();
        $this->assertSame('h3k2c9v8b7n6m5l4k3j2h1g0', $kim->getAttribute('document_id'));
        $this->assertSame('2024-10-27T03:33:20.000000Z', $kim->created_at?->toISOString());
        $this->postJson('/admin/login', ['email' => 'kim@example.test', 'password' => 'Strapi-pass-1'])->assertOk();
        $this->app['auth']->forgetGuards();
        $this->postJson('/admin/login', ['email' => 'lee@example.test', 'password' => 'anything'])
            ->assertStatus(400)->assertJsonPath('error.message', 'Invalid credentials');
        $this->assertFalse(User::query()->where('email', 'kim@example.test')->exists());
    }
}
