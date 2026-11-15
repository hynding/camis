<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Pages\ConfigureComponentView;
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
use App\Support\StrapiComponentViews;
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
        foreach ($permissions as $permission) {
            \Spatie\Permission\Models\Permission::findOrCreate($permission, 'web');
        }
        $user = AdminUser::forceCreate(['firstname' => $name, 'email' => strtolower($name).'@example.test', 'is_active' => true]);
        $user->givePermissionTo($permissions);
        $this->actingAs($user, 'admin');
        Filament::setCurrentPanel(Filament::getPanel('admin'));

        return $user;
    }

    private static function fixture(string $name): string
    {
        $directory = getenv('CAMIS_TRANSFER_FIXTURES') ?: base_path('../packages/adapter-filament/src/strapi-api/__fixtures__/transfer');

        return $directory.'/'.$name;
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

    public function test_a_relation_is_labelled_by_the_main_field_its_view_names(): void
    {
        $this->login(['post.read', 'post.update']);
        $author = Author::create(['name' => 'Ann']);
        $post = Post::create(['title' => 'Kept', 'views' => 7, 'author_id' => $author->id]);
        $this->assertSame('name', StrapiContentManager::configuration(PostResource::CONTENT_MANAGER)['metadatas']['author']['edit']['mainField']);
        // As Strapi's "Configure the view" saves a relation's entry title, for the form and the list.
        $stored = StrapiContentManager::defaults(PostResource::CONTENT_MANAGER);
        $stored['metadatas']['author']['edit']['mainField'] = 'id';
        $stored['metadatas']['author']['list']['mainField'] = 'id';
        StrapiSettings::merge(StrapiContentManager::key(PostResource::CONTENT_MANAGER), $stored);

        Livewire::test(EditPost::class, ['record' => $post->getRouteKey()])
            ->assertFormFieldExists('author_id', fn (\Filament\Forms\Components\Select $select): bool => $select->getOptionLabel() === (string) $author->id);
        Livewire::test(ListPosts::class)
            ->assertTableColumnStateSet('author.name', (string) $author->id, $post);

        // A main field the target does not have falls back to its default here, and saving the view
        // keeps the one Strapi stored, for the export to give back.
        $stored['metadatas']['author']['edit']['mainField'] = 'gone';
        StrapiSettings::merge(StrapiContentManager::key(PostResource::CONTENT_MANAGER), $stored);
        $this->assertSame('name', StrapiContentManager::configuration(PostResource::CONTENT_MANAGER)['metadatas']['author']['edit']['mainField']);
        $view = PostResource::CONTENT_MANAGER;
        StrapiContentManager::save($view, StrapiContentManager::fromFormState($view, StrapiContentManager::formState($view)));
        $this->assertSame('gone', StrapiSettings::get(StrapiContentManager::key($view))['metadatas']['author']['edit']['mainField']);
    }

    public function test_a_relations_entry_title_is_picked_in_configure_the_view(): void
    {
        $this->login(['post.read', 'post.update']);
        $author = Author::create(['name' => 'Ann']);
        $post = Post::create(['title' => 'Kept', 'views' => 7, 'author_id' => $author->id]);

        $page = Livewire::test(ConfigurePostsView::class);
        $editKey = array_keys($page->get('data.edit'))[array_search('author', array_column($page->get('data.edit'), 'name'), true)];
        $listKey = array_keys($page->get('data.list'))[array_search('author', array_column($page->get('data.list'), 'name'), true)];
        $this->assertSame('name', $page->get("data.edit.{$editKey}.mainField"));
        $page->set("data.edit.{$editKey}.mainField", 'id')
            ->set("data.list.{$listKey}.mainField", 'id')
            ->call('save')
            ->assertHasNoFormErrors();

        $stored = StrapiSettings::get(StrapiContentManager::key(PostResource::CONTENT_MANAGER));
        $this->assertSame('id', $stored['metadatas']['author']['edit']['mainField']);
        $this->assertSame('id', $stored['metadatas']['author']['list']['mainField']);
        // Only a relation has an entry title.
        $this->assertArrayNotHasKey('mainField', $stored['metadatas']['title']['edit']);
        Livewire::test(EditPost::class, ['record' => $post->getRouteKey()])
            ->assertFormFieldExists('author_id', fn (\Filament\Forms\Components\Select $select): bool => $select->getOptionLabel() === (string) $author->id);
        Livewire::test(ListPosts::class)
            ->assertTableColumnStateSet('author.name', (string) $author->id, $post);

        // An entry title the target does not have is refused.
        Livewire::test(ConfigurePostsView::class)
            ->set("data.edit.{$editKey}.mainField", 'gone')
            ->call('save');
        $this->assertSame('id', StrapiSettings::get(StrapiContentManager::key(PostResource::CONTENT_MANAGER))['metadatas']['author']['edit']['mainField']);
    }

    public function test_a_components_view_is_configured_in_the_admin(): void
    {
        $this->login(['menu.read', 'menu.update', 'user.update']);
        $author = Author::create(['name' => 'Ann']);
        $menu = \App\Models\Menu::create(['title' => 'Main', 'cta_author_id' => $author->id]);
        // The menu's view links each component attribute to its component's view.
        Livewire::test(\App\Filament\Resources\Menus\Pages\ConfigureMenusView::class)
            ->assertSee(ConfigureComponentView::getUrl(['component' => 'shared.link']), escape: false);

        $page = Livewire::test(ConfigureComponentView::class, ['component' => 'shared.link']);
        $keys = array_combine(array_column($page->get('data.edit'), 'name'), array_keys($page->get('data.edit')));
        $this->assertSame(['label', 'author', 'topics'], array_keys($keys));
        $page->set('data.settings.mainField', 'label')
            ->set("data.edit.{$keys['label']}.label", 'Link text')
            ->set("data.edit.{$keys['label']}.description", 'What the link says')
            ->set("data.edit.{$keys['label']}.editable", false)
            ->set("data.edit.{$keys['author']}.mainField", 'id')
            ->set("data.edit.{$keys['topics']}.shown", false)
            ->set("data.edit.{$keys['topics']}.editable", false)
            ->call('save')
            ->assertHasNoFormErrors();

        $stored = StrapiSettings::get('content-manager.configuration.components::shared.link');
        $this->assertSame('Link text', $stored['metadatas']['label']['edit']['label']);
        $this->assertSame('id', $stored['metadatas']['author']['edit']['mainField']);
        $this->assertSame([[['name' => 'label', 'size' => 6], ['name' => 'author', 'size' => 6]]], $stored['layouts']['edit']);

        // Every use of the component follows it: the relation inside is titled as its view says.
        Livewire::test(\App\Filament\Resources\Menus\Pages\EditMenu::class, ['record' => $menu->getRouteKey()])
            ->assertSee('Link text')
            ->assertSee('What the link says')
            ->assertFormFieldDisabled('cta_label')
            ->assertFormFieldExists('cta_author_id', fn (\Filament\Forms\Components\Select $select): bool => $select->getOptionLabel() === (string) $author->id)
            // What the view leaves out is still edited, never locked: hiding it would lose its data.
            ->assertFormFieldVisible('ctaTopics')
            ->assertFormFieldEnabled('ctaTopics');
        // Strapi titles a component by neither a relation nor its id.
        $this->assertSame(['label'], StrapiContentManager::sortable(StrapiComponentViews::VIEWS['shared.link']));
    }

    public function test_only_a_settings_admin_configures_a_components_view(): void
    {
        $this->login(['menu.read', 'menu.update']);
        Livewire::test(ConfigureComponentView::class, ['component' => 'shared.link'])->assertForbidden();
        Livewire::test(\App\Filament\Resources\Menus\Pages\ConfigureMenusView::class)
            ->assertDontSee(ConfigureComponentView::getUrl(['component' => 'shared.link']), escape: false);

        $this->login(['user.update'], 'Settings');
        Livewire::test(ConfigureComponentView::class, ['component' => 'shared.nothing'])->assertNotFound();
    }

    public function test_a_components_fields_are_laid_out_by_its_view(): void
    {
        $this->login(['menu.read', 'menu.update']);
        $menu = \App\Models\Menu::create(['title' => 'Main']);
        // Link's view as Strapi keeps it: author before label, label renamed and locked, topics left out.
        StrapiSettings::merge('content-manager.configuration.components::shared.link', [
            'settings' => ['mainField' => 'label'],
            'metadatas' => ['label' => ['edit' => ['label' => 'Link text', 'description' => 'What the link says', 'placeholder' => '', 'visible' => true, 'editable' => false]]],
            'layouts' => ['edit' => [[['name' => 'author', 'size' => 6], ['name' => 'label', 'size' => 6]]]],
        ]);

        Livewire::test(\App\Filament\Resources\Menus\Pages\EditMenu::class, ['record' => $menu->getRouteKey()])
            ->assertSee('Link text')
            ->assertSee('What the link says')
            ->assertFormFieldDisabled('cta_label')
            // What the view leaves out is still edited, after what it lays out: hiding it would lose its data.
            ->assertFormFieldVisible('ctaTopics')
            ->assertFormFieldVisible('cta_author_id');
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

    /**
     * As Strapi sizes a custom field: its registration's inputSize gives the default size in the
     * edit view, and one that is not resizable keeps that size whatever a saved view says.
     */
    public function test_a_custom_field_is_sized_as_its_registration_says(): void
    {
        $view = PostResource::CONTENT_MANAGER;
        $view['attributes']['views']['customField'] = 'plugin::meter.gauge';
        \App\Support\CustomFields::flush();
        try {
            // Unregistered here, it takes its type's size.
            $this->assertContains(['name' => 'views', 'size' => 4], array_merge(...StrapiContentManager::defaults($view)['layouts']['edit']));

            \App\Support\CustomFields::register(['name' => 'gauge', 'plugin' => 'meter', 'type' => 'integer', 'inputSize' => ['default' => 8, 'isResizable' => false]]);
            $this->assertContains(['name' => 'views', 'size' => 8], array_merge(...StrapiContentManager::defaults($view)['layouts']['edit']));
            $this->assertSame([8 => 'Large (2/3)'], StrapiContentManager::sizes($view['attributes']['views']));
            $stored = StrapiContentManager::defaults($view);
            $stored['layouts']['edit'] = [[['name' => 'title', 'size' => 6], ['name' => 'views', 'size' => 4]]];
            $edit = StrapiContentManager::sync($view, $stored)['layouts']['edit'];
            $this->assertSame(['name' => 'views', 'size' => 8], $edit[1][0] ?? null);

            \App\Support\CustomFields::flush();
            \App\Support\CustomFields::register(['name' => 'gauge', 'plugin' => 'meter', 'type' => 'integer', 'inputSize' => ['default' => 12, 'isResizable' => true]]);
            $this->assertContains(['name' => 'views', 'size' => 12], array_merge(...StrapiContentManager::defaults($view)['layouts']['edit']));
            $this->assertSame([4, 6, 8, 12], array_keys(StrapiContentManager::sizes($view['attributes']['views'])));
        } finally {
            \App\Support\CustomFields::flush();
        }
    }

    /**
     * transfer/view-config-export.tar.gz is strapi-php's archive (strapi-php-export.tar.gz) with
     * Post's view configured as Strapi's "Configure the view" saves it: twenty a page by views,
     * newest first, no bulk actions; title (labelled Headline), views and createdAt listed; views
     * then title on the first edit row, views locked, image left out. Hero's view is changed too.
     */
    public function test_a_view_configured_in_strapi_comes_over_with_its_archive(): void
    {
        $this->login(['post.read', 'post.update']);
        $this->artisan('strapi:import', ['--file' => self::fixture('view-config-export.tar.gz'), '--force' => true])->assertSuccessful();

        $list = Livewire::test(ListPosts::class);
        $table = $list->instance()->getTable();
        $this->assertFalse($list->instance()->isTableColumnToggledHidden('title'));
        $this->assertFalse($list->instance()->isTableColumnToggledHidden('created_at'));
        $this->assertTrue($list->instance()->isTableColumnToggledHidden('id'));
        $this->assertTrue($list->instance()->isTableColumnToggledHidden('author.name'));
        $list->assertSee('Headline');
        $this->assertSame('views', $table->getDefaultSortColumn());
        $this->assertSame('desc', $table->getDefaultSortDirection());
        $this->assertSame(20, $table->getDefaultPaginationPageOption());
        $this->assertSame([], $table->getToolbarActions());

        $post = Post::create(['title' => 'Kept', 'views' => 7]);
        Livewire::test(EditPost::class, ['record' => $post->getRouteKey()])
            ->assertSee('Headline')
            ->assertSee('What readers see first')
            ->assertFormFieldDisabled('views')
            ->assertFormFieldHidden('image');
        $this->assertSame(
            [[['name' => 'views', 'size' => 4], ['name' => 'title', 'size' => 8]], [['name' => 'author', 'size' => 6], ['name' => 'topics', 'size' => 6]]],
            StrapiContentManager::configuration(PostResource::CONTENT_MANAGER)['layouts']['edit'],
        );
        // A component's view comes over too, for the next export to carry.
        $this->assertSame('Title', StrapiSettings::get('content-manager.configuration.components::shared.hero')['metadatas']['heading']['edit']['label']);
    }

    public function test_saving_a_view_keeps_what_strapi_stored_beyond_it(): void
    {
        $this->login(['post.read', 'post.update']);
        $this->artisan('strapi:import', ['--file' => self::fixture('view-config-export.tar.gz'), '--force' => true])->assertSuccessful();

        Livewire::test(ConfigurePostsView::class)
            ->fillForm(['settings' => ['pageSize' => 50]])
            ->call('save')
            ->assertHasNoFormErrors();

        $stored = StrapiSettings::get('content-manager.configuration.api::post.post');
        $this->assertSame(50, $stored['settings']['pageSize']);
        // What Strapi keeps and this admin does not use goes back out with the next export.
        $this->assertSame('modal', $stored['settings']['relationOpenMode']);
        $this->assertSame('name', $stored['metadatas']['author']['edit']['mainField']);
        $this->assertSame('api::post.post', $stored['uid']);
    }

    public function test_an_import_replaces_the_views_unless_settings_are_left_out(): void
    {
        $this->login(['post.read', 'post.update']);
        $saved = StrapiContentManager::defaults(PostResource::CONTENT_MANAGER);
        $saved['layouts']['list'] = ['views', 'id', 'title', 'author'];
        StrapiContentManager::save(PostResource::CONTENT_MANAGER, $saved);
        $this->artisan('strapi:import', ['--file' => self::fixture('view-config-export.tar.gz'), '--force' => true, '--exclude' => 'config'])->assertSuccessful();
        $this->assertSame(['views', 'id', 'title', 'author'], StrapiSettings::get('content-manager.configuration.api::post.post')['layouts']['list']);

        // strapi-php's own archive holds Strapi's default view, which replaces the saved one.
        $this->artisan('strapi:import', ['--file' => self::fixture('strapi-php-export.tar.gz'), '--force' => true])->assertSuccessful();
        $this->assertSame(['id', 'title', 'views', 'author'], StrapiSettings::get('content-manager.configuration.api::post.post')['layouts']['list']);
    }

    public function test_only_who_may_update_the_type_configures_its_view(): void
    {
        $this->login(['post.read']);
        Livewire::test(ListPosts::class)->assertActionHidden('configure');
        $this->get(PostResource::getUrl('configure'))->assertForbidden();
        Livewire::test(ConfigurePostsView::class)->assertForbidden();
    }
}
