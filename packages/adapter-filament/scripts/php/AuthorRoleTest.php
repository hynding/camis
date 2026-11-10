<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Memos\MemoResource;
use App\Filament\Resources\Memos\Pages\ListMemos;
use App\Filament\Resources\Stories\Pages\CreateStory;
use App\Filament\Resources\Stories\Pages\ListStories;
use App\Filament\Resources\Stories\StoryResource;
use App\Models\AdminUser;
use App\Models\Memo;
use App\Models\Story;
use App\Models\User;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * Strapi's default Author and Editor admin roles (the author-role fixture): an Author creates
 * entries and lists, opens, edits, deletes and publishes only the ones it created
 * (admin::is-creator), while an Editor does all of it to every entry, and the content API's users
 * are held to neither. CI's author-role job copies this into the scaffolded app's tests/Feature.
 */
class AuthorRoleTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        Filament::setCurrentPanel(Filament::getPanel('admin'));
    }

    private function admin(string $email, string $role): AdminUser
    {
        $admin = AdminUser::forceCreate(['firstname' => ucfirst($role), 'email' => $email, 'password' => 'Admin-pass-1', 'is_active' => true]);
        $admin->assignRole($role);

        return $admin;
    }

    /** A story made in the admin by $admin, which records it as the story's creator. */
    private function storyBy(AdminUser $admin, string $title): Story
    {
        $this->actingAs($admin, 'admin');

        return Story::create(['title' => $title]);
    }

    public function test_an_author_lists_and_opens_only_the_entries_it_created(): void
    {
        $author = $this->admin('author@example.test', 'author');
        $editor = $this->admin('editor@example.test', 'editor');
        $own = $this->storyBy($author, 'Mine');
        $other = $this->storyBy($editor, 'Theirs');
        $this->assertSame($author->id, $own->created_by_id);

        $this->actingAs($author, 'admin');
        Livewire::test(ListStories::class)
            ->assertCanSeeTableRecords([$own])
            ->assertCanNotSeeTableRecords([$other]);
        $this->get(StoryResource::getUrl('edit', ['record' => $own]))->assertOk();
        $this->get(StoryResource::getUrl('edit', ['record' => $other]))->assertNotFound();

        $this->actingAs($editor, 'admin');
        Livewire::test(ListStories::class)->assertCanSeeTableRecords([$own, $other]);
        $this->get(StoryResource::getUrl('edit', ['record' => $own]))->assertOk();
    }

    public function test_an_author_changes_only_the_entries_it_created(): void
    {
        $author = $this->admin('author@example.test', 'author');
        $editor = $this->admin('editor@example.test', 'editor');
        $own = $this->storyBy($author, 'Mine');
        $other = $this->storyBy($editor, 'Theirs');

        foreach (['view', 'update', 'delete', 'publish'] as $ability) {
            $this->assertTrue($author->can($ability, $own), "author may $ability its own story");
            $this->assertFalse($author->can($ability, $other), "author may not $ability another's story");
            $this->assertTrue($editor->can($ability, $own), "editor may $ability any story");
        }
        $this->assertTrue($author->can('create', Story::class));
    }

    public function test_an_entry_an_author_creates_is_its_own(): void
    {
        $author = $this->admin('author@example.test', 'author');
        $this->actingAs($author, 'admin');
        Livewire::test(CreateStory::class)->fillForm(['title' => 'Draft one'])->call('create')->assertHasNoFormErrors();

        $story = Story::query()->where('title', 'Draft one')->firstOrFail();
        $this->assertSame($author->id, $story->created_by_id);
        $this->assertTrue($author->can('update', $story));
    }

    public function test_a_plain_type_lists_to_an_author_only_its_own(): void
    {
        $author = $this->admin('author@example.test', 'author');
        $editor = $this->admin('editor@example.test', 'editor');
        $this->actingAs($author, 'admin');
        $own = Memo::create(['title' => 'Mine']);
        $this->actingAs($editor, 'admin');
        $other = Memo::create(['title' => 'Theirs']);

        $this->actingAs($author, 'admin');
        Livewire::test(ListMemos::class)
            ->assertCanSeeTableRecords([$own])
            ->assertCanNotSeeTableRecords([$other]);
        $this->get(MemoResource::getUrl('edit', ['record' => $other]))->assertNotFound();
        $this->assertFalse($author->can('delete', $other));
        $this->assertTrue($author->can('delete', $own));
    }

    // An account with no role reading the type lists nothing, rather than every entry.
    public function test_an_admin_without_a_reading_role_lists_nothing(): void
    {
        $editor = $this->admin('editor@example.test', 'editor');
        $this->storyBy($editor, 'Theirs');
        $nobody = AdminUser::forceCreate(['firstname' => 'Nobody', 'email' => 'nobody@example.test', 'is_active' => true]);

        $this->assertSame(0, Story::query()->forAdmin($nobody)->count());
        $this->assertSame(0, Story::query()->forAdmin(null)->count());
    }

    // createdBy is an admin account: an API user whose id happens to equal the creator's is not it,
    // even holding the Author role, while the API's own role reads every story outright.
    public function test_the_content_api_users_are_held_to_neither_condition(): void
    {
        $author = $this->admin('author@example.test', 'author');
        $story = $this->storyBy($author, 'Mine');
        $impostor = User::forceCreate(['id' => $author->id, 'username' => 'impostor', 'email' => 'impostor@example.test', 'password' => 'Impostor-pass-1']);
        $impostor->assignRole('author');
        $reader = User::forceCreate(['username' => 'reader', 'email' => 'reader@example.test', 'password' => 'Reader-pass-1']);
        $reader->assignRole('authenticated');
        $this->assertTrue($reader->can('view', $story));
        $this->assertFalse($reader->can('update', $story));
        $this->assertFalse($impostor->can('update', $story));
    }
}
