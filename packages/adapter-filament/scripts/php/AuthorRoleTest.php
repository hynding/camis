<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Files\FileResource;
use App\Filament\Resources\Files\Pages\ListFiles;
use App\Filament\Resources\Memos\MemoResource;
use App\Filament\Resources\Memos\Pages\ListMemos;
use App\Filament\Resources\Stories\Pages\CreateStory;
use App\Filament\Resources\Stories\Pages\ListStories;
use App\Filament\Resources\Stories\StoryResource;
use App\Http\Serializers\StorySerializer;
use App\Models\AdminUser;
use App\Models\File;
use App\Models\Memo;
use App\Models\Story;
use App\Models\User;
use App\Support\StrapiDocuments;
use App\Support\StrapiHomepage;
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

        // A fresh session: the author's would sign the editor out on the next request.
        $this->flushSession();
        $this->app['auth']->forgetGuards();
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

    /** Strapi's admin::has-same-role-as-creator: a Reviewer lists and changes what a Reviewer made. */
    public function test_a_reviewer_reads_and_changes_the_memos_an_account_of_its_role_created(): void
    {
        $first = $this->admin('first@example.test', 'reviewer');
        $second = $this->admin('second@example.test', 'reviewer');
        $editor = $this->admin('editor@example.test', 'editor');
        $this->actingAs($first, 'admin');
        $shared = Memo::create(['title' => 'Shared']);
        $this->actingAs($editor, 'admin');
        $other = Memo::create(['title' => 'Editor\'s']);

        $this->actingAs($second, 'admin');
        Livewire::test(ListMemos::class)
            ->assertCanSeeTableRecords([$shared])
            ->assertCanNotSeeTableRecords([$other]);
        $this->get(MemoResource::getUrl('edit', ['record' => $other]))->assertNotFound();
        $this->assertTrue($second->can('update', $shared));
        $this->assertFalse($second->can('update', $other));
        $this->assertFalse($second->can('delete', $shared));

        // A creator who shares no role with the account, or no creator at all, lets nothing through.
        $orphan = Memo::create(['title' => 'Orphan']);
        $orphan->forceFill(['created_by_id' => null])->save();
        $this->assertFalse($second->can('view', $orphan));
    }

    /** A file $admin uploaded in the admin, which records it as the file's creator. */
    private function fileBy(AdminUser $admin, string $name): File
    {
        $this->actingAs($admin, 'admin');

        return File::forceCreate([
            'name' => $name, 'hash' => md5($name), 'ext' => '.png', 'mime' => 'image/png',
            'size' => 1.5, 'url' => "/uploads/{$name}", 'provider' => 'local',
        ]);
    }

    /** Strapi's Author reads and changes only the files it uploaded; an Editor every one. */
    public function test_an_author_lists_and_changes_only_the_files_it_uploaded(): void
    {
        $author = $this->admin('author@example.test', 'author');
        $editor = $this->admin('editor@example.test', 'editor');
        $own = $this->fileBy($author, 'mine.png');
        $other = $this->fileBy($editor, 'theirs.png');
        $this->assertSame($author->id, $own->created_by_id);

        $this->actingAs($author, 'admin');
        Livewire::test(ListFiles::class)
            ->assertCanSeeTableRecords([$own])
            ->assertCanNotSeeTableRecords([$other]);
        $this->get(FileResource::getUrl('edit', ['record' => $other]))->assertNotFound();
        $this->assertTrue($author->can('update', $own));
        $this->assertFalse($author->can('update', $other));
        $this->assertFalse($author->can('delete', $other));
        $this->assertTrue($author->can('create', File::class));

        $this->flushSession();
        $this->app['auth']->forgetGuards();
        $this->actingAs($editor, 'admin');
        Livewire::test(ListFiles::class)->assertCanSeeTableRecords([$own, $other]);
    }

    public function test_the_homepage_widgets_show_an_author_only_its_own_entries(): void
    {
        $author = $this->admin('author@example.test', 'author');
        $editor = $this->admin('editor@example.test', 'editor');
        $own = $this->storyBy($author, 'Mine');
        $other = $this->storyBy($editor, 'Theirs');
        StrapiDocuments::publish($own, StorySerializer::class);
        StrapiDocuments::publish($other, StorySerializer::class);

        $this->actingAs($author, 'admin');
        $this->assertSame(['Mine'], array_column(StrapiHomepage::lastEdited(), 'title'));
        $this->assertSame(['Mine'], array_column(StrapiHomepage::lastPublished(), 'title'));

        $this->actingAs($editor, 'admin');
        $this->assertEqualsCanonicalizing(['Mine', 'Theirs'], array_column(StrapiHomepage::lastEdited(), 'title'));
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
        $impostor = User::forceCreate(['id' => $author->id, 'name' => 'Impostor', 'username' => 'impostor', 'email' => 'impostor@example.test', 'password' => 'Impostor-pass-1']);
        $impostor->assignRole('author');
        $reader = User::forceCreate(['name' => 'Reader', 'username' => 'reader', 'email' => 'reader@example.test', 'password' => 'Reader-pass-1']);
        $reader->assignRole('authenticated');
        $this->assertTrue($reader->can('view', $story));
        $this->assertFalse($reader->can('update', $story));
        $this->assertFalse($impostor->can('update', $story));
    }
}
