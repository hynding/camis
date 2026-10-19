<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Pages\UsersPermissionsSettings;
use App\Filament\Resources\Users\Pages\CreateUser;
use App\Filament\Resources\Users\Pages\EditUser;
use App\Filament\Resources\Users\Pages\ListUsers;
use App\Models\User;
use App\Support\StrapiUsers;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The generated Filament admin for users-permissions (the strapi-api fixture's builtin User): an
 * account made or blocked here is one the API sees, the advanced settings change without a
 * redeploy, and both are out of reach without the user grants. CI copies this into the scaffolded
 * app's tests/Feature.
 */
class UsersAdminTest extends TestCase
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

    public function test_an_account_made_and_blocked_here_is_one_the_api_sees(): void
    {
        $admin = $this->login(['user.read', 'user.create', 'user.update']);
        Livewire::test(CreateUser::class)
            ->fillForm(['username' => 'carol', 'email' => 'Carol@Example.test', 'password' => 'secret1', 'confirmed' => true])
            ->call('create')
            ->assertHasNoFormErrors();

        $carol = User::where('username', 'carol')->sole();
        $this->assertSame('carol@example.test', $carol->email);
        $this->assertTrue(Hash::check('secret1', $carol->password));
        $wire = StrapiUsers::wire($carol);
        $this->assertSame(['local', true, false], [$wire['provider'], $wire['confirmed'], $wire['blocked']]);
        $this->assertSame(24, strlen($wire['documentId']));
        Livewire::test(ListUsers::class)->assertCanSeeTableRecords([$admin, $carol]);

        Livewire::test(EditUser::class, ['record' => $carol->getRouteKey()])
            ->fillForm(['blocked' => true, 'password' => ''])
            ->call('save')
            ->assertHasNoFormErrors();
        $carol->refresh();
        $this->assertTrue((bool) $carol->blocked);
        $this->assertTrue(Hash::check('secret1', $carol->password), 'an empty password field keeps the password');
    }

    public function test_the_advanced_settings_change_without_a_redeploy(): void
    {
        $this->login(['user.read', 'user.update']);
        $this->assertTrue((bool) StrapiUsers::advanced()['allow_register']);
        Livewire::test(UsersPermissionsSettings::class)
            ->fillForm(['advanced.allow_register' => false, 'advanced.email_confirmation_redirection' => 'https://example.test/welcome'])
            ->call('save')
            ->assertHasNoFormErrors();

        $this->assertFalse((bool) StrapiUsers::advanced()['allow_register']);
        $this->assertSame('https://example.test/welcome', StrapiUsers::advanced()['email_confirmation_redirection']);
        $this->assertSame('Reset password', StrapiUsers::emails()['reset_password']['object']);
    }

    public function test_users_and_their_settings_are_denied_without_the_user_grants(): void
    {
        $this->login(['book.read']);
        Livewire::test(ListUsers::class)->assertForbidden();
        Livewire::test(CreateUser::class)->assertForbidden();
        Livewire::test(UsersPermissionsSettings::class)->assertForbidden();
    }

    public function test_reading_users_does_not_open_making_them(): void
    {
        $this->login(['user.read']);
        Livewire::test(ListUsers::class)->assertOk();
        Livewire::test(CreateUser::class)->assertForbidden();
        Livewire::test(UsersPermissionsSettings::class)->assertForbidden();
    }
}
