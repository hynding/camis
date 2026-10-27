<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Articles\Pages\ListArticles;
use App\Filament\Resources\Globals\GlobalResource;
use App\Filament\Resources\Globals\Pages\ListGlobals;
use App\Filament\Resources\Homepages\HomepageResource;
use App\Filament\Resources\Homepages\Pages\CreateHomepage;
use App\Filament\Resources\Homepages\Pages\ListHomepages;
use App\Filament\Resources\Roles\Pages\ListRoles;
use App\Filament\Resources\Roles\Pages\ViewRole;
use App\Filament\Resources\Roles\RoleResource;
use App\Filament\Resources\Tags\TagResource;
use App\Models\GlobalModel;
use App\Models\Homepage;
use App\Models\Locale;
use App\Models\Tag;
use App\Models\User;
use Filament\Facades\Filament;
use Filament\Navigation\NavigationGroup;
use Filament\Navigation\NavigationItem;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use Spatie\Permission\Models\Role;
use Tests\TestCase;

/**
 * The admin laid out as Strapi's: the menu's groups and order, the list's create button, a single
 * type's one entry, and the Roles page, which shows the IR's grants and changes nothing. CI copies
 * this into the scaffolded app's tests/Feature.
 */
class StrapiAdminTest extends TestCase
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

    /** @return array<string, list<string>> Each group's label → its items' labels, in menu order. */
    private function menu(): array
    {
        $menu = [];
        foreach (Filament::getCurrentOrDefaultPanel()->getNavigation() as $group) {
            /** @var NavigationGroup $group */
            $menu[(string) ($group->getLabel() ?? '')] = array_values(array_map(fn (NavigationItem $item): string => (string) $item->getLabel(), $group->getItems()->all()));
        }

        return $menu;
    }

    public function test_the_menu_is_strapis_content_manager_then_settings(): void
    {
        $this->login(['user.update', 'article.read', 'book.read', 'note.read', 'file.read', 'user.read', 'homepage.read', 'global.read']);
        $menu = $this->menu();

        $this->assertSame(['', 'Collection Types', 'Single Types', 'Settings'], array_keys($menu));
        $this->assertSame(['Global', 'Homepage'], $menu['Single Types']);
        $types = $menu['Collection Types'];
        $this->assertSame(['Article', 'Book', 'Note', 'User'], array_values(array_intersect($types, ['Article', 'Book', 'Note', 'User'])));
        $this->assertContains('Media Library', $menu['']);
        $this->assertSame(
            ['API Tokens', 'Internationalization', 'Transfer Tokens', 'Webhooks', 'Data transfer', 'Roles', 'Users & Permissions'],
            $menu['Settings'],
        );
    }

    public function test_a_list_offers_create_new_entry(): void
    {
        $this->login(['article.read', 'article.create']);
        Livewire::test(ListArticles::class)->assertActionVisible('create')->assertSee('Create new entry');
    }

    public function test_a_single_type_with_no_entry_opens_its_create_form(): void
    {
        $this->login(['homepage.read', 'homepage.update']);
        Livewire::test(ListHomepages::class)->assertRedirect(HomepageResource::getUrl('create'));
    }

    public function test_a_single_type_opens_its_one_entry(): void
    {
        $this->login(['homepage.read', 'homepage.update']);
        $entry = Homepage::create(['title' => 'Welcome']);

        Livewire::test(ListHomepages::class)->assertRedirect(HomepageResource::getUrl('edit', ['record' => $entry]));
        Livewire::test(CreateHomepage::class)->assertRedirect(HomepageResource::getUrl('edit', ['record' => $entry]));
    }

    public function test_a_single_types_entry_is_made_with_its_update_grant(): void
    {
        $this->login(['homepage.read', 'homepage.update']);
        Livewire::test(CreateHomepage::class)->fillForm(['title' => 'Welcome'])->call('create')->assertHasNoFormErrors();
        $this->assertSame(['Welcome'], Homepage::query()->pluck('title')->all());
    }

    public function test_a_single_types_entry_is_not_made_without_its_update_grant(): void
    {
        $this->login(['homepage.read']);
        Livewire::test(CreateHomepage::class)->assertForbidden();
        $this->assertSame(0, Homepage::query()->count());
    }

    public function test_a_localized_single_type_opens_its_default_locale(): void
    {
        $this->login(['global.read', 'global.update']);
        Locale::firstOrCreate(['code' => 'fr'], ['name' => 'French (fr)']);
        $fr = new GlobalModel(['site_name' => 'Le site']);
        $fr->locale = 'fr';
        $fr->save();
        $en = new GlobalModel(['site_name' => 'Site']);
        $en->locale = 'en';
        $en->document_id = $fr->document_id;
        $en->save();

        Livewire::test(ListGlobals::class)->assertRedirect(GlobalResource::getUrl('edit', ['record' => $en]));
    }

    // The IR's roles only read tags: the admin refuses the rest, as the API does.
    public function test_the_admin_refuses_what_no_role_grants(): void
    {
        $this->login(['tag.read']);
        $tag = Tag::create(['label' => 'news']);

        $this->assertTrue(TagResource::canViewAny());
        $this->assertFalse(TagResource::canCreate());
        $this->assertFalse(TagResource::canEdit($tag));
        $this->assertFalse(TagResource::canDelete($tag));
    }

    public function test_the_roles_page_lists_each_role_with_strapis_description(): void
    {
        $user = $this->login(['user.update']);
        $user->assignRole('authenticated');

        Livewire::test(ListRoles::class)
            ->assertCanSeeTableRecords(Role::whereIn('name', ['authenticated', 'public'])->get())
            ->assertSee('Default role given to authenticated user.')
            ->assertSee('Default role given to unauthenticated user.');
    }

    public function test_a_role_shows_its_actions_and_the_conditions_on_them(): void
    {
        $this->login(['user.update']);
        $role = Role::findByName('authenticated');

        $page = Livewire::test(ViewRole::class, ['record' => $role->getKey()])->assertOk();
        $state = $page->instance()->form->getRawState();
        $this->assertEqualsCanonicalizing(['find', 'findOne', 'create', 'update', 'delete'], $state[md5('api::note.note')]);
        $this->assertEqualsCanonicalizing(['find', 'findOne', 'create', 'update', 'delete', 'publish'], $state[md5('api::post.post')]);
        $this->assertEqualsCanonicalizing(['find', 'findOne', 'count'], $state[md5('plugin::users-permissions.user')]);
        $page->assertSee('find, findOne, create, update, delete: record.ownerId = user.id');

        $public = Livewire::test(ViewRole::class, ['record' => Role::findByName('public')->getKey()]);
        $this->assertEqualsCanonicalizing(['find', 'findOne'], $public->instance()->form->getRawState()[md5('api::book.book')]);
        $this->assertSame([], $public->instance()->form->getRawState()[md5('api::note.note')]);
    }

    public function test_the_roles_page_changes_nothing(): void
    {
        $this->login(['user.update']);
        $role = Role::findByName('authenticated');
        $this->assertFalse(RoleResource::canCreate());
        $this->assertFalse(RoleResource::canEdit($role));
        $this->assertFalse(RoleResource::canDelete($role));
        $this->assertArrayNotHasKey('edit', RoleResource::getPages());
    }

    public function test_the_roles_page_is_out_of_reach_without_the_grant_to_change_accounts(): void
    {
        $this->login(['user.read']);
        Livewire::test(ListRoles::class)->assertForbidden();
    }
}
