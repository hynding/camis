<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Authors\Pages\EditAuthor;
use App\Filament\Resources\Authors\Pages\ListAuthors;
use App\Filament\Resources\Pages\Pages\EditPage;
use App\Filament\Resources\Posts\Pages\EditPost;
use App\Filament\Resources\Posts\Pages\ListPosts;
use App\Http\Serializers\PostSerializer;
use App\Models\AdminUser;
use App\Models\Author;
use App\Models\Locale;
use App\Models\Page;
use App\Models\Post;
use App\Models\User;
use App\Support\StrapiDocuments;
use Filament\Actions\Testing\TestAction;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The generated Content Manager lists as Strapi's does (the strapi-api fixture's Post, Page and
 * Author): it searches text and number fields, starts sorted by the main field, deletes an entry
 * with every version of it (in its locale only), deletes and publishes in bulk, and offers none
 * of it without the grant. CI copies this into the scaffolded app's tests/Feature.
 */
class ContentManagerListTest extends TestCase
{
    use RefreshDatabase;

    private function login(array $permissions): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $user = AdminUser::forceCreate(['firstname' => 'Admin', 'email' => 'admin@example.test', 'is_active' => true]);
        $user->givePermissionTo($permissions);
        $this->actingAs($user, 'admin');
        Filament::setCurrentPanel(Filament::getPanel('admin'));
    }

    private function published(string $title, int $views = 0): Post
    {
        $draft = Post::create(['title' => $title, 'views' => $views]);
        StrapiDocuments::publish($draft, PostSerializer::class);

        return $draft->fresh();
    }

    public function test_the_list_searches_text_and_numbers_and_sorts_by_the_main_field(): void
    {
        $this->login(['author.read', 'post.read']);
        $bob = Author::create(['name' => 'Bob']);
        $ann = Author::create(['name' => 'Ann']);
        Livewire::test(ListAuthors::class)
            ->assertCanSeeTableRecords([$ann, $bob], inOrder: true)
            ->searchTable('an')
            ->assertCanSeeTableRecords([$ann])
            ->assertCanNotSeeTableRecords([$bob])
            ->sortTable('name', 'desc')
            ->searchTable('')
            ->assertCanSeeTableRecords([$bob, $ann], inOrder: true);

        $one = Post::create(['title' => 'One', 'views' => 7]);
        $two = Post::create(['title' => 'Two', 'views' => 70]);
        Livewire::test(ListPosts::class)
            ->searchTable('7')
            ->assertCanSeeTableRecords([$one])
            ->assertCanNotSeeTableRecords([$two]);
    }

    public function test_deleting_an_entry_deletes_every_version_of_it(): void
    {
        $this->login(['post.read', 'post.update', 'post.delete']);
        $kept = $this->published('Kept');
        $draft = $this->published('Gone');
        $this->assertSame(4, Post::count());

        Livewire::test(EditPost::class, ['record' => $draft->getRouteKey()])->callAction('delete');
        $this->assertSame(0, Post::where('document_id', $draft->document_id)->count());
        $this->assertSame(2, Post::where('document_id', $kept->document_id)->count());

        Livewire::test(ListPosts::class)->callAction(TestAction::make('delete')->table($kept));
        $this->assertSame(0, Post::count());
    }

    public function test_bulk_actions_delete_publish_and_unpublish(): void
    {
        $this->login(['post.read', 'post.update', 'post.delete', 'post.publish']);
        $one = Post::create(['title' => 'One']);
        $two = Post::create(['title' => 'Two']);
        $three = Post::create(['title' => 'Three']);

        Livewire::test(ListPosts::class)->selectTableRecords([$one, $two])->callAction(TestAction::make('publish')->table()->bulk());
        $this->assertSame('Published', StrapiDocuments::status($one->fresh()));
        $this->assertSame('Published', StrapiDocuments::status($two->fresh()));
        $this->assertSame('Draft', StrapiDocuments::status($three->fresh()));

        Livewire::test(ListPosts::class)->selectTableRecords([$two])->callAction(TestAction::make('unpublish')->table()->bulk());
        $this->assertSame('Draft', StrapiDocuments::status($two->fresh()));

        Livewire::test(ListPosts::class)->selectTableRecords([$one, $three])->callAction(TestAction::make('delete')->table()->bulk());
        $this->assertSame(['Two'], Post::pluck('title')->all());
    }

    public function test_a_localized_entry_is_deleted_in_its_locale_only(): void
    {
        $this->login(['page.read', 'page.update', 'page.delete']);
        Locale::create(['code' => 'fr', 'name' => 'French (fr)']);
        $english = Page::create(['title' => 'Hello', 'locale' => 'en']);
        Page::create(['title' => 'Bonjour', 'locale' => 'fr', 'document_id' => $english->document_id]);

        $french = Page::where('locale', 'fr')->firstOrFail();
        Livewire::test(EditPage::class, ['record' => $french->getRouteKey()])->callAction('delete');
        $this->assertSame(['en'], Page::where('document_id', $english->document_id)->pluck('locale')->all());
    }

    public function test_nothing_is_deleted_or_published_without_the_grant(): void
    {
        $this->login(['post.read', 'post.update', 'author.read', 'author.update']);
        $post = Post::create(['title' => 'One']);
        $author = Author::create(['name' => 'Ann']);

        Livewire::test(EditPost::class, ['record' => $post->getRouteKey()])->assertActionHidden('delete');
        Livewire::test(EditAuthor::class, ['record' => $author->getRouteKey()])->assertActionHidden('delete');
        Livewire::test(ListPosts::class)
            ->assertActionHidden(TestAction::make('delete')->table($post))
            ->assertActionHidden(TestAction::make('delete')->table()->bulk())
            ->assertActionHidden(TestAction::make('publish')->table()->bulk())
            ->assertActionHidden(TestAction::make('unpublish')->table()->bulk());
        Livewire::test(ListAuthors::class)->assertActionHidden(TestAction::make('delete')->table()->bulk());
        $this->assertSame(1, Post::count());
    }
}
