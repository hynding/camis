<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Resources\Authors\Pages\ListAuthors;
use App\Filament\Resources\Books\Pages\EditBook;
use App\Filament\Resources\Posts\Pages\ConfigurePostsView;
use App\Filament\Resources\Posts\Pages\CreatePost;
use App\Filament\Resources\Posts\Pages\EditPost;
use App\Filament\Resources\Posts\Pages\ListPosts;
use App\Filament\Resources\Posts\PostResource;
use App\Filament\Resources\Submissions\Pages\CreateSubmission;
use App\Filament\Resources\Submissions\Pages\EditSubmission;
use App\Filament\Resources\Submissions\Pages\ListSubmissions;
use App\Http\Serializers\PostSerializer;
use App\Models\AdminUser;
use App\Models\Author;
use App\Models\Book;
use App\Models\Post;
use App\Models\Submission;
use App\Models\Topic;
use App\Models\User;
use App\Support\StrapiContentManager;
use App\Support\StrapiDocuments;
use App\Support\StrapiSettings;
use App\Support\StrapiUid;
use Filament\Actions\Testing\TestAction;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The generated Content Manager does what Strapi's does beyond its list basics (the strapi-api
 * fixture's Post, Author, Book and Submission): filters a list by its fields and relations,
 * duplicates an entry (directly, or through a create form when it has a uid or unique field),
 * makes a uid from its target field, records who made and last changed an entry, and lays the
 * list and the edit form out as "Configure the view" saved them. Denied paths included. CI copies
 * this into the scaffolded app's tests/Feature.
 */
class ContentManagerViewTest extends TestCase
{
    use RefreshDatabase;

    private function login(array $permissions, string $name = 'Admin'): AdminUser
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        $user = AdminUser::forceCreate(['firstname' => $name, 'email' => strtolower($name).'@example.test', 'is_active' => true]);
        $user->givePermissionTo($permissions);
        $this->actingAs($user, 'admin');
        Filament::setCurrentPanel(Filament::getPanel('admin'));

        return $user;
    }

    private function rule(string $type, string $operator, array $settings): array
    {
        return ['rules' => ['rule' => ['type' => $type, 'data' => ['operator' => $operator, 'settings' => $settings]]]];
    }

    public function test_the_list_filters_by_a_field_and_by_a_relation(): void
    {
        $this->login(['post.read', 'author.read']);
        $ann = Author::create(['name' => 'Ann']);
        $bob = Author::create(['name' => 'Bob']);
        $first = Post::create(['title' => 'First steps', 'views' => 3, 'author_id' => $ann->id]);
        $second = Post::create(['title' => 'Second thoughts', 'views' => 30, 'author_id' => $bob->id]);

        Livewire::test(ListPosts::class)
            ->filterTable('queryBuilder', $this->rule('title', 'contains', ['text' => 'first']))
            ->assertCanSeeTableRecords([$first])
            ->assertCanNotSeeTableRecords([$second]);
        Livewire::test(ListPosts::class)
            ->filterTable('queryBuilder', $this->rule('views', 'isMin', ['number' => 10]))
            ->assertCanSeeTableRecords([$second])
            ->assertCanNotSeeTableRecords([$first]);
        Livewire::test(ListPosts::class)
            ->filterTable('queryBuilder', $this->rule('author', 'isRelatedTo', ['value' => [$bob->id]]))
            ->assertCanSeeTableRecords([$second])
            ->assertCanNotSeeTableRecords([$first]);
    }

    public function test_an_entry_is_duplicated_with_its_relations_as_a_new_draft(): void
    {
        $admin = $this->login(['post.read', 'post.create', 'post.update', 'post.publish']);
        $ann = Author::create(['name' => 'Ann']);
        $topic = Topic::create(['name' => 'News']);
        $post = Post::create(['title' => 'Original', 'views' => 5, 'author_id' => $ann->id]);
        $post->topics()->sync([$topic->id]);
        StrapiDocuments::publish($post, PostSerializer::class);

        Livewire::test(ListPosts::class)->callAction(TestAction::make('duplicate')->table($post));

        $copy = Post::query()->whereNull('published_at')->where('document_id', '!=', $post->document_id)->sole();
        $this->assertSame('Original', $copy->title);
        $this->assertSame(5, (int) $copy->views);
        $this->assertSame($ann->id, (int) $copy->author_id);
        $this->assertSame([$topic->id], $copy->topics()->pluck('topics.id')->all());
        $this->assertSame('Draft', StrapiDocuments::status($copy));
        $this->assertSame($admin->id, (int) $copy->created_by_id);
        // The original keeps its own links and its published version.
        $this->assertSame([$topic->id], $post->fresh()->topics()->pluck('topics.id')->all());
        $this->assertSame(1, Post::query()->whereNotNull('published_at')->count());

        Livewire::test(EditPost::class, ['record' => $copy->getRouteKey()])->callAction('duplicate');
        $this->assertSame(3, Post::query()->whereNull('published_at')->count());
    }

    public function test_an_entry_with_components_is_duplicated_with_its_items(): void
    {
        $this->login(['book.read', 'book.create', 'book.update']);
        $book = Book::create(['title' => 'Dune', 'price_minor' => 999, 'price_currency' => 'USD']);
        $book->editions()->createMany([['amount' => 1, 'unit' => 'hardcover'], ['amount' => 2, 'unit' => 'paperback']]);

        Livewire::test(EditBook::class, ['record' => $book->getRouteKey()])->callAction('duplicate');

        $copy = Book::query()->whereKeyNot($book->id)->sole();
        $this->assertSame(999, (int) $copy->price_minor);
        $this->assertSame(['hardcover', 'paperback'], $copy->editions()->orderBy('id')->pluck('unit')->all());
        $this->assertSame(2, $book->editions()->count());
    }

    public function test_an_entry_with_a_uid_is_duplicated_through_the_create_form(): void
    {
        $this->login(['submission.read', 'submission.create', 'submission.update']);
        $source = Submission::create(['title' => 'Alpha', 'handle' => 'alpha', 'kind' => 'beta']);
        $source->lines()->create(['label' => 'One', 'quantity' => 2]);

        Livewire::test(ListSubmissions::class)
            ->callAction(TestAction::make('duplicate')->table($source))
            ->assertRedirect(\App\Filament\Resources\Submissions\SubmissionResource::getUrl('create', ['duplicate' => $source->getKey()]));

        $form = Livewire::withQueryParams(['duplicate' => (string) $source->getKey()])->test(CreateSubmission::class)
            ->assertSchemaStateSet(['title' => 'Alpha', 'handle' => 'alpha', 'kind' => 'beta']);
        // The uid is taken until it is changed, as Strapi asks.
        $form->call('create')->assertHasFormErrors(['handle']);
        $form->fillForm(['handle' => 'alpha-copy'])->call('create')->assertHasNoFormErrors();

        $copy = Submission::query()->where('handle', 'alpha-copy')->sole();
        $this->assertSame('beta', $copy->kind);
        $this->assertSame(['One'], $copy->lines()->pluck('label')->all());
        $this->assertSame(['One'], $source->lines()->pluck('label')->all());
    }

    public function test_nothing_is_duplicated_without_the_create_grant(): void
    {
        $this->login(['post.read', 'post.update']);
        $post = Post::create(['title' => 'Mine']);

        Livewire::test(ListPosts::class)->assertActionHidden(TestAction::make('duplicate')->table($post));
        Livewire::test(EditPost::class, ['record' => $post->getRouteKey()])->assertActionHidden('duplicate');
        $this->assertSame(1, Post::count());
    }

    public function test_a_uid_is_made_from_its_target_field_and_kept_unique(): void
    {
        $this->login(['submission.read', 'submission.create', 'submission.update']);
        $this->assertSame('hello-world-again', StrapiUid::slugify('Hello  World, again!'));
        $this->assertSame('foo-bar', StrapiUid::slugify('fooBar'));

        Livewire::test(CreateSubmission::class)
            ->assertSchemaStateSet(['handle' => 'submission'])
            ->fillForm(['title' => 'My Title', 'lines' => []])
            ->assertSchemaStateSet(['handle' => 'my-title'])
            ->call('create')
            ->assertHasNoFormErrors();

        Livewire::test(CreateSubmission::class)
            ->fillForm(['title' => 'My Title', 'lines' => []])
            ->assertSchemaStateSet(['handle' => 'my-title-1'])
            ->fillForm(['handle' => 'my-title'])
            ->call('create')
            ->assertHasFormErrors(['handle']);

        $saved = Submission::query()->where('handle', 'my-title')->sole();
        Livewire::test(EditSubmission::class, ['record' => $saved->getRouteKey()])
            ->fillForm(['title' => 'Other'])
            // Editing an entry leaves its uid alone until it is regenerated.
            ->assertSchemaStateSet(['handle' => 'my-title'])
            ->callAction(TestAction::make('regenerate')->schemaComponent('handle'))
            ->assertSchemaStateSet(['handle' => 'other'])
            ->call('save')
            ->assertHasNoFormErrors();
        $this->assertSame('other', $saved->fresh()->handle);
    }

    public function test_an_entry_records_who_made_and_last_changed_it_in_the_admin_only(): void
    {
        $ann = $this->login(['author.read', 'author.create', 'author.update'], 'Ann');
        Livewire::test(\App\Filament\Resources\Authors\Pages\CreateAuthor::class)
            ->fillForm(['name' => 'Tolkien'])
            ->call('create')
            ->assertHasNoFormErrors();
        $author = Author::query()->where('name', 'Tolkien')->sole();
        $this->assertSame($ann->id, (int) $author->created_by_id);
        $this->assertSame($ann->id, (int) $author->updated_by_id);

        $bob = AdminUser::forceCreate(['firstname' => 'Bob', 'email' => 'bob@example.test', 'is_active' => true]);
        $bob->givePermissionTo(['author.read', 'author.update']);
        $this->actingAs($bob, 'admin');
        Livewire::test(\App\Filament\Resources\Authors\Pages\EditAuthor::class, ['record' => $author->getRouteKey()])
            ->assertSee('Ann')
            ->fillForm(['name' => 'J. R. R. Tolkien'])
            ->call('save')
            ->assertHasNoFormErrors();
        $author->refresh();
        $this->assertSame($ann->id, (int) $author->created_by_id);
        $this->assertSame($bob->id, (int) $author->updated_by_id);
        Livewire::test(ListAuthors::class)
            ->filterTable('queryBuilder', $this->rule('updatedBy', 'isRelatedTo', ['value' => [$bob->id]]))
            ->assertCanSeeTableRecords([$author]);

        // A write outside the admin (the Content API, a seeder) records nobody, as Strapi's does.
        Filament::setCurrentPanel(null);
        $outside = Author::create(['name' => 'Outside']);
        $this->assertNull($outside->created_by_id);
    }

    public function test_the_list_is_laid_out_as_the_view_was_configured(): void
    {
        $this->login(['post.read', 'post.update', 'post.delete']);
        foreach (range(1, 12) as $i) {
            Post::create(['title' => sprintf('Post %02d', $i), 'views' => $i]);
        }

        // Strapi's defaults: id and the first three listable fields, ten a page, by the main field.
        // The others are a toggle away, as Strapi's list offers every listable field.
        $this->assertTrue(Livewire::test(ListPosts::class)->instance()->isTableColumnToggledHidden('created_at'));
        Livewire::test(ListPosts::class)
            ->assertTableColumnVisible('id')
            ->assertTableColumnVisible('title')
            ->assertTableColumnVisible('views')
            ->assertTableColumnVisible('author.name')
            ->assertCountTableRecords(12)
            ->assertCanSeeTableRecords(Post::query()->orderBy('title')->limit(10)->get(), inOrder: true);

        Livewire::test(ConfigurePostsView::class)
            ->fillForm([
                'settings' => ['pageSize' => 20, 'defaultSortBy' => 'views', 'defaultSortOrder' => 'DESC', 'bulkable' => false, 'filterable' => false],
                'list' => [
                    ['name' => 'views', 'label' => 'Reads', 'sortable' => true],
                    ['name' => 'title', 'label' => 'title', 'sortable' => false],
                ],
            ])
            ->call('save')
            ->assertHasNoFormErrors();

        $stored = StrapiSettings::get('content-manager.configuration.api::post.post');
        $this->assertSame(['views', 'title'], $stored['layouts']['list']);
        $this->assertSame('Reads', $stored['metadatas']['views']['list']['label']);

        $list = Livewire::test(ListPosts::class);
        $this->assertFalse($list->instance()->isTableColumnToggledHidden('views'));
        $this->assertTrue($list->instance()->isTableColumnToggledHidden('id'));
        $this->assertTrue($list->instance()->isTableColumnToggledHidden('author.name'));
        $list
            ->assertSee('Reads')
            ->assertCanSeeTableRecords(Post::query()->orderByDesc('views')->get(), inOrder: true);
        $this->assertSame([], $list->instance()->getTable()->getToolbarActions());
        $this->assertNull($list->instance()->getTable()->getFilter('queryBuilder'));
        $this->assertFalse(Livewire::test(ListPosts::class)->instance()->getTable()->getColumn('title')->isSortable());
    }

    public function test_the_edit_form_is_laid_out_as_the_view_was_configured(): void
    {
        $this->login(['post.read', 'post.create', 'post.update']);
        $post = Post::create(['title' => 'Kept', 'views' => 7]);
        $state = StrapiContentManager::formState(PostResource::CONTENT_MANAGER);
        $edit = array_map(fn (array $field): array => match ($field['name']) {
            'title' => [...$field, 'label' => 'Headline', 'description' => 'What readers see first', 'placeholder' => 'A headline'],
            'views' => [...$field, 'editable' => false],
            'image' => [...$field, 'shown' => false],
            default => $field,
        }, $state['edit']);

        Livewire::test(ConfigurePostsView::class)
            ->set('data.edit', array_combine(array_map(fn (int $i): string => "item{$i}", array_keys($edit)), $edit))
            ->call('save')
            ->assertHasNoFormErrors();

        Livewire::test(EditPost::class, ['record' => $post->getRouteKey()])
            ->assertSee('Headline')
            ->assertSee('What readers see first')
            ->assertSchemaComponentExists('views')
            ->assertFormFieldDisabled('views')
            ->assertFormFieldHidden('image')
            ->fillForm(['title' => 'Changed', 'views' => 99])
            ->call('save')
            ->assertHasNoFormErrors();
        $this->assertSame('Changed', $post->fresh()->title);
        $this->assertSame(7, (int) $post->fresh()->views);
    }

    public function test_a_saved_view_follows_the_type_as_it_changes(): void
    {
        $view = PostResource::CONTENT_MANAGER;
        // A configuration saved before a field existed, naming one that no longer does.
        $stored = StrapiContentManager::defaults($view);
        unset($stored['metadatas']['image']);
        $stored['layouts']['list'] = ['id', 'gone', 'title'];
        $stored['layouts']['edit'] = [[['name' => 'gone', 'size' => 6], ['name' => 'title', 'size' => 12]], [['name' => 'views', 'size' => 4]]];
        $synced = StrapiContentManager::sync($view, $stored);
        $this->assertSame(['id', 'title'], $synced['layouts']['list']);
        $this->assertSame([[['name' => 'title', 'size' => 12]], [['name' => 'views', 'size' => 4], ['name' => 'image', 'size' => 6]]], $synced['layouts']['edit']);
    }

    public function test_only_who_may_update_the_type_configures_its_view(): void
    {
        $this->login(['post.read']);
        Livewire::test(ListPosts::class)->assertActionHidden('configure');
        $this->get(PostResource::getUrl('configure'))->assertForbidden();
        Livewire::test(ConfigurePostsView::class)->assertForbidden();
    }
}
