<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Posts\Pages\EditPost;
use App\Filament\Resources\Posts\Pages\ListPosts;
use App\Models\Post;
use App\Models\User;
use App\Support\StrapiDocuments;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The generated Filament admin for a draft-and-publish type (the strapi-api fixture's Post): it
 * lists drafts, publishes, discards and unpublishes, and hides publishing without the grant. CI
 * copies this into the scaffolded app's tests/Feature.
 */
class DraftAdminTest extends TestCase
{
    use RefreshDatabase;

    private function login(array $permissions): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $user = User::factory()->create(['username' => 'admin']);
        $user->givePermissionTo($permissions);
        $this->actingAs($user);
        Filament::setCurrentPanel(Filament::getPanel('admin'));
    }

    public function test_the_edit_page_publishes_discards_and_unpublishes(): void
    {
        $this->login(['post.read', 'post.update', 'post.publish', 'post.create']);
        $draft = Post::create(['title' => 'One', 'views' => 1]);
        Livewire::test(ListPosts::class)->assertCanSeeTableRecords([$draft]);
        $page = Livewire::test(EditPost::class, ['record' => $draft->getRouteKey()]);
        $page->assertActionVisible('publish')->assertActionHidden('unpublish');
        $page->fillForm(['title' => 'One, published'])->callAction('publish')->assertHasNoErrors();
        $this->assertSame(2, Post::count());
        $published = Post::whereNotNull('published_at')->first();
        $this->assertSame('One, published', $published->title);
        $this->assertSame('Published', StrapiDocuments::status($draft->fresh()));

        $page = Livewire::test(EditPost::class, ['record' => $draft->getRouteKey()]);
        // Timestamps have second resolution; Modified means edited after the publish.
        $this->travel(2)->seconds();
        $page->fillForm(['title' => 'edited'])->call('save');
        $this->assertSame('Modified', StrapiDocuments::status($draft->fresh()));
        $page->callAction('discard');
        $this->assertSame('One, published', $draft->fresh()->title);
        $page->callAction('unpublish');
        $this->assertSame(1, Post::count());
        Livewire::test(ListPosts::class)->assertCanSeeTableRecords([$draft])->assertCountTableRecords(1);
    }

    public function test_publishing_is_hidden_without_the_publish_grant(): void
    {
        $this->login(['post.read', 'post.update']);
        $draft = Post::create(['title' => 'One']);
        Livewire::test(EditPost::class, ['record' => $draft->getRouteKey()])->assertActionHidden('publish');
    }
}
