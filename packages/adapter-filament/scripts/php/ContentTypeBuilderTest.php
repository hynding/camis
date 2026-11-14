<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Pages\ContentTypeBuilder;
use App\Models\AdminUser;
use App\Models\Post;
use App\Models\Tag;
use App\Models\User;
use App\Support\ContentTypeBuilder as Builder;
use Filament\Actions\Testing\TestAction;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Process\PendingProcess;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Process;
use Illuminate\Support\Facades\Schema;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * Strapi's Content-Type Builder on the strapi-api fixture: read-only outside development, an
 * editor of the camis project's IR under "camis develop" (here a project in a temporary directory,
 * its build faked), and the schema sync that keeps the data across a rebuild. CI copies this into
 * the scaffolded app's tests/Feature.
 */
class ContentTypeBuilderTest extends TestCase
{
    use RefreshDatabase;

    private string $project;

    protected function tearDown(): void
    {
        if (isset($this->project)) {
            array_map('unlink', glob($this->project.'/*') ?: []);
            rmdir($this->project);
        }
        parent::tearDown();
    }

    private function login(array $permissions): void
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        foreach ($permissions as $permission) {
            \Spatie\Permission\Models\Permission::findOrCreate($permission);
        }
        $user = AdminUser::forceCreate(['firstname' => 'Admin', 'email' => 'admin@example.test', 'is_active' => true]);
        $user->givePermissionTo($permissions);
        $this->actingAs($user, 'admin');
        Filament::setCurrentPanel(Filament::getPanel('admin'));
    }

    /** A camis project whose IR is the one this app was built from, as "camis develop" names it. */
    private function develop(): void
    {
        $this->project = sys_get_temp_dir().'/camis-ctb-'.bin2hex(random_bytes(4));
        mkdir($this->project);
        copy(base_path(Builder::SCHEMA_PATH), $this->project.'/camis.json');
        file_put_contents($this->project.'/roles.json', json_encode(['roles' => [
            ['name' => 'super-admin', 'admin' => true, 'grants' => [['contentType' => 'Tag', 'actions' => ['read']]]],
            ['name' => 'public', 'grants' => [['contentType' => 'Tag', 'actions' => ['read']], ['contentType' => 'Post', 'actions' => ['read', 'publish']]]],
        ]], JSON_PRETTY_PRINT));
        file_put_contents($this->project.'/camis.config.json', json_encode(['ir' => './camis.json', 'roles' => './roles.json', 'targets' => []]));
        config([
            'content-type-builder.project' => $this->project.'/camis.config.json',
            'content-type-builder.build_command' => 'camis build --config '.$this->project.'/camis.config.json',
            // Development, as far as the builder is concerned: Filament's form testing needs APP_ENV=testing.
            'content-type-builder.environments' => ['testing'],
        ]);
    }

    /** @return array<string, mixed> */
    private function ir(): array
    {
        return json_decode((string) file_get_contents($this->project.'/camis.json'), true);
    }

    /** @return array<string, mixed> */
    private function type(string $name): array
    {
        foreach ($this->ir()['contentTypes'] as $type) {
            if ($type['name'] === $name) {
                return $type;
            }
        }
        $this->fail("no content type {$name}");
    }

    public function test_it_lists_the_model_the_app_was_built_from_read_only(): void
    {
        $this->login(['user.update']);
        $this->assertNotNull(Builder::readOnlyReason());

        Livewire::test(ContentTypeBuilder::class, ['type' => 'contentType:Post'])
            ->assertSee('Collection type · api::post.post')
            ->assertSee('title')
            ->assertSee('Relation with Author')
            ->assertSee('only edits the content model in development')
            ->assertActionHidden(TestAction::make('addField')->table())
            ->assertActionHidden(TestAction::make('editField')->table('title'))
            ->assertActionHidden(TestAction::make('deleteField')->table('title'))
            ->assertActionHidden('editType')
            ->assertActionHidden('deleteType');

        // The media library's file type is the upload plugin's, hidden as in Strapi.
        $navigation = collect(Livewire::test(ContentTypeBuilder::class)->instance()->getSubNavigation());
        $this->assertContains('Post', $navigation->map->getLabel()->all());
        $this->assertNotContains('File', $navigation->map->getLabel()->all());
        $this->assertContains('Components · shared', $navigation->map->getGroup()->unique()->all());
    }

    public function test_only_users_who_may_change_settings_may_open_it(): void
    {
        $this->login(['post.read']);

        Livewire::test(ContentTypeBuilder::class)->assertForbidden();
    }

    public function test_it_stays_read_only_in_development_without_camis_develop(): void
    {
        $this->login(['user.update']);
        config(['content-type-builder.environments' => ['testing']]);

        $this->assertStringContainsString('camis develop', (string) Builder::readOnlyReason());
        Livewire::test(ContentTypeBuilder::class)->assertActionHidden(TestAction::make('addField')->table());
    }

    public function test_a_field_added_in_development_goes_to_the_ir_and_rebuilds_the_app(): void
    {
        $this->login(['user.update']);
        $this->develop();
        Process::fake();

        Livewire::test(ContentTypeBuilder::class, ['type' => 'contentType:Tag'])
            ->callAction(TestAction::make('addField')->table(), data: [
                'kind' => 'text', 'name' => 'color', 'textType' => 'string', 'required' => true, 'maxLength' => '20',
            ])
            ->assertHasNoActionErrors()
            ->assertRedirect(ContentTypeBuilder::getUrl(['type' => 'contentType:Tag']));

        $this->assertSame(
            [['type' => 'string', 'name' => 'label'], ['type' => 'string', 'name' => 'color', 'required' => true, 'maxLength' => 20]],
            $this->type('Tag')['fields'],
        );
        // As camis writes JSON, so the project's IR diffs cleanly.
        $this->assertStringEndsWith("}\n", (string) file_get_contents($this->project.'/camis.json'));
        $this->assertStringContainsString("\n  \"contentTypes\": [", (string) file_get_contents($this->project.'/camis.json'));
        Process::assertRan(fn (PendingProcess $process): bool => $process->command === config('content-type-builder.build_command') && $process->path === $this->project);
        Process::assertRan(fn (PendingProcess $process): bool => is_array($process->command) && in_array('camis:schema-sync', $process->command, true));
    }

    public function test_a_failed_build_leaves_the_ir_and_roles_as_they_were(): void
    {
        $this->login(['user.update']);
        $this->develop();
        $ir = file_get_contents($this->project.'/camis.json');
        $roles = file_get_contents($this->project.'/roles.json');
        Process::fake(['camis build*' => Process::result(output: '✗ [invalid] Tag.color — boom', exitCode: 1)]);

        Livewire::test(ContentTypeBuilder::class, ['type' => 'contentType:Tag'])
            ->callAction(TestAction::make('addField')->table(), data: ['kind' => 'boolean', 'name' => 'shown'])
            ->assertNotified('Not saved')
            ->assertNoRedirect();

        $this->assertSame($ir, file_get_contents($this->project.'/camis.json'));
        $this->assertSame($roles, file_get_contents($this->project.'/roles.json'));
        Process::assertDidntRun(fn (PendingProcess $process): bool => is_array($process->command));
    }

    public function test_a_refused_edit_writes_nothing_and_says_why(): void
    {
        $this->login(['user.update']);
        $this->develop();
        $ir = file_get_contents($this->project.'/camis.json');
        Process::fake();

        Livewire::test(ContentTypeBuilder::class, ['type' => 'contentType:Tag'])
            ->callAction(TestAction::make('addField')->table(), data: ['kind' => 'text', 'name' => 'label'])
            ->assertNotified('Not saved');

        $this->assertSame($ir, file_get_contents($this->project.'/camis.json'));
        Process::assertNothingRan();
    }

    public function test_a_new_collection_type_is_the_super_admins_to_do_everything_with(): void
    {
        $this->login(['user.update']);
        $this->develop();
        Process::fake();

        Livewire::test(ContentTypeBuilder::class)
            ->callAction('createCollectionType', data: ['displayName' => 'Press release', 'draftPublish' => true])
            ->assertRedirect(ContentTypeBuilder::getUrl(['type' => 'contentType:PressRelease']));

        $this->assertSame(
            ['name' => 'PressRelease', 'kind' => 'collection', 'names' => ['display' => 'Press release'], 'fields' => [], 'options' => ['draftPublish' => true]],
            $this->type('PressRelease'),
        );
        $roles = json_decode((string) file_get_contents($this->project.'/roles.json'), true);
        $this->assertContains(['contentType' => 'PressRelease', 'actions' => ['create', 'read', 'update', 'delete', 'publish']], $roles['roles'][0]['grants']);
        // Other roles get nothing they were not given.
        $this->assertSame(['Tag', 'Post'], array_column($roles['roles'][1]['grants'], 'contentType'));
    }

    public function test_deleting_a_type_drops_the_relations_and_grants_that_name_it(): void
    {
        $this->login(['user.update']);
        $this->develop();
        Process::fake();

        Livewire::test(ContentTypeBuilder::class, ['type' => 'contentType:Author'])->callAction('deleteType');

        $this->assertNotContains('Author', array_column($this->ir()['contentTypes'], 'name'));
        $this->assertNotContains('author', array_column($this->type('Post')['fields'], 'name'));
    }

    public function test_draft_and_publish_turned_off_takes_publish_from_every_grant(): void
    {
        $this->login(['user.update']);
        $this->develop();
        Process::fake();

        Livewire::test(ContentTypeBuilder::class, ['type' => 'contentType:Post'])
            ->callAction('editType', data: ['displayName' => 'Post', 'draftPublish' => false]);

        $options = $this->type('Post')['options'] ?? [];
        $this->assertArrayNotHasKey('draftPublish', $options);
        $roles = json_decode((string) file_get_contents($this->project.'/roles.json'), true);
        $this->assertContains(['contentType' => 'Post', 'actions' => ['read']], $roles['roles'][1]['grants']);
    }

    public function test_editing_a_field_keeps_what_the_dialog_does_not_show(): void
    {
        $this->login(['user.update']);
        $this->develop();
        Process::fake();

        Livewire::test(ContentTypeBuilder::class, ['type' => 'contentType:Post'])
            ->callAction(TestAction::make('editField')->table('author'), data: ['name' => 'writer', 'inverse' => 'writings'])
            ->assertHasNoActionErrors();

        $author = collect($this->type('Post')['fields'])->firstWhere('name', 'writer');
        $this->assertSame(['type' => 'relation', 'name' => 'writer', 'relationKind' => 'manyToOne', 'target' => 'Author', 'inverse' => 'writings'], $author);
    }

    public function test_a_component_is_made_used_and_deleted_as_in_strapi(): void
    {
        $this->login(['user.update']);
        $this->develop();
        Process::fake();

        Livewire::test(ContentTypeBuilder::class)
            ->callAction('createComponent', data: ['displayName' => 'Call to action', 'category' => 'blocks'])
            ->assertRedirect(ContentTypeBuilder::getUrl(['type' => 'component:CallToAction']));
        Livewire::test(ContentTypeBuilder::class, ['type' => 'component:CallToAction'])
            ->callAction(TestAction::make('addField')->table(), data: ['kind' => 'text', 'name' => 'label', 'textType' => 'string'])
            ->assertHasNoActionErrors();
        Livewire::test(ContentTypeBuilder::class, ['type' => 'contentType:Tag'])
            ->callAction(TestAction::make('addField')->table(), data: ['kind' => 'component', 'name' => 'cta', 'component' => 'CallToAction', 'repeatable' => true])
            ->callAction(TestAction::make('addField')->table(), data: ['kind' => 'dynamicZone', 'name' => 'blocks', 'components' => ['CallToAction', 'Seo']])
            ->assertHasNoActionErrors();

        $component = collect($this->ir()['components'])->firstWhere('name', 'CallToAction');
        // The display name typed is kept, as Strapi keeps it beside the uid made from it.
        $this->assertSame(['name' => 'CallToAction', 'names' => ['display' => 'Call to action', 'group' => 'blocks'], 'fields' => [['type' => 'string', 'name' => 'label']]], $component);
        $this->assertSame([
            ['type' => 'string', 'name' => 'label'],
            ['type' => 'component', 'name' => 'cta', 'component' => 'CallToAction', 'repeatable' => true],
            ['type' => 'dynamicZone', 'name' => 'blocks', 'components' => ['CallToAction', 'Seo']],
        ], $this->type('Tag')['fields']);

        // A component holds no dynamic zone, as in Strapi: its dialog does not offer one.
        Livewire::test(ContentTypeBuilder::class, ['type' => 'component:CallToAction'])
            ->callAction(TestAction::make('addField')->table(), data: ['kind' => 'dynamicZone', 'name' => 'zone', 'components' => ['Seo']])
            ->assertHasActionErrors(['kind']);

        Livewire::test(ContentTypeBuilder::class, ['type' => 'component:CallToAction'])->callAction('deleteType');
        $this->assertSame([
            ['type' => 'string', 'name' => 'label'],
            ['type' => 'dynamicZone', 'name' => 'blocks', 'components' => ['Seo']],
        ], $this->type('Tag')['fields']);
    }

    public function test_a_type_has_a_description_and_a_component_a_display_name_and_icon(): void
    {
        $this->login(['user.update']);
        $this->develop();
        Process::fake();

        Livewire::test(ContentTypeBuilder::class)
            ->callAction('createCollectionType', data: ['displayName' => 'Press release', 'description' => 'What we tell the press'])
            ->assertHasNoActionErrors();
        $this->assertSame('What we tell the press', $this->type('PressRelease')['description']);

        Livewire::test(ContentTypeBuilder::class, ['type' => 'contentType:PressRelease'])
            ->assertSee('What we tell the press')
            ->callAction('editType', data: ['displayName' => 'Press release', 'description' => ''])
            ->assertHasNoActionErrors();
        $this->assertArrayNotHasKey('description', $this->type('PressRelease'));

        Livewire::test(ContentTypeBuilder::class)
            ->callAction('createComponent', data: ['displayName' => 'Call to action', 'category' => 'blocks', 'icon' => 'cursor'])
            ->assertHasNoActionErrors();
        Livewire::test(ContentTypeBuilder::class, ['type' => 'component:CallToAction'])
            ->mountAction('editType')
            ->assertSchemaStateSet(['displayName' => 'Call to action', 'icon' => 'cursor', 'category' => 'blocks']);
        Livewire::test(ContentTypeBuilder::class, ['type' => 'component:CallToAction'])
            ->callAction('editType', data: ['displayName' => 'Button', 'icon' => 'hand', 'description' => 'A link that looks like a button', 'category' => 'links'])
            ->assertHasNoActionErrors();

        $this->assertSame(
            ['name' => 'CallToAction', 'names' => ['display' => 'Button', 'group' => 'links'], 'fields' => [], 'icon' => 'hand', 'description' => 'A link that looks like a button'],
            collect($this->ir()['components'])->firstWhere('name', 'CallToAction'),
        );
    }

    public function test_a_relation_is_one_of_strapis_six_kinds(): void
    {
        $this->login(['user.update']);
        $this->develop();
        Process::fake();

        Livewire::test(ContentTypeBuilder::class, ['type' => 'contentType:Tag'])
            ->callAction(TestAction::make('addField')->table(), data: ['kind' => 'relation', 'name' => 'lead', 'relationKind' => 'oneWay', 'target' => 'Author', 'inverse' => 'ignored'])
            ->callAction(TestAction::make('addField')->table(), data: ['kind' => 'relation', 'name' => 'seen', 'relationKind' => 'manyWay', 'target' => 'Author'])
            ->callAction(TestAction::make('addField')->table(), data: ['kind' => 'relation', 'name' => 'curators', 'relationKind' => 'manyToMany', 'target' => 'Author', 'inverse' => 'curated'])
            ->assertHasNoActionErrors();

        $fields = collect($this->type('Tag')['fields'])->keyBy('name');
        // One-way and many-way are Strapi's names for a relation the other type does not show.
        $this->assertSame(['type' => 'relation', 'name' => 'lead', 'relationKind' => 'oneToOne', 'target' => 'Author'], $fields['lead']);
        $this->assertSame(['type' => 'relation', 'name' => 'seen', 'relationKind' => 'oneToMany', 'target' => 'Author'], $fields['seen']);
        $this->assertSame(['type' => 'relation', 'name' => 'curators', 'relationKind' => 'manyToMany', 'target' => 'Author', 'inverse' => 'curated'], $fields['curators']);
        $this->assertSame('oneWay', \App\Support\ContentTypeBuilderSchema::stateFromField($fields['lead'])['relationKind']);
        $this->assertSame('manyWay', \App\Support\ContentTypeBuilderSchema::stateFromField($fields['seen'])['relationKind']);
        $this->assertSame('manyToMany', \App\Support\ContentTypeBuilderSchema::stateFromField($fields['curators'])['relationKind']);
    }

    public function test_a_field_changes_to_a_type_in_another_group(): void
    {
        $this->login(['user.update']);
        $this->develop();
        Process::fake();

        // Text to number: a field kept in one column of its table may become any other such field.
        Livewire::test(ContentTypeBuilder::class, ['type' => 'contentType:Tag'])
            ->callAction(TestAction::make('editField')->table('label'), data: ['kind' => 'number', 'numberType' => 'integer', 'min' => '0'])
            ->assertHasNoActionErrors();

        $this->assertSame([['type' => 'integer', 'name' => 'label', 'min' => 0]], $this->type('Tag')['fields']);
        Process::assertRan(fn (PendingProcess $process): bool => is_array($process->command) && in_array('camis:schema-sync', $process->command, true));
    }

    public function test_a_type_change_drops_the_settings_and_links_the_new_type_cannot_have(): void
    {
        $ir = ['contentTypes' => [['name' => 'Page', 'kind' => 'collection', 'fields' => [
            ['type' => 'string', 'name' => 'title', 'maxLength' => 80, 'default' => 'Untitled', 'localized' => false],
            ['type' => 'uid', 'name' => 'slug', 'targetField' => 'title'],
        ]]], 'components' => []];

        $after = \App\Support\ContentTypeBuilderSchema::updateField($ir, 'contentType:Page', 'title', ['kind' => 'number', 'numberType' => 'integer', 'name' => 'title', 'maxLength' => '80', 'default' => 'Untitled']);

        // A uid made from a field that keeps its type keeps being made from it.
        $kept = \App\Support\ContentTypeBuilderSchema::updateField(
            ['contentTypes' => [['name' => 'Page', 'kind' => 'collection', 'fields' => [['type' => 'email', 'name' => 'contact'], ['type' => 'uid', 'name' => 'slug', 'targetField' => 'contact']]]], 'components' => []],
            'contentType:Page', 'contact', ['kind' => 'email', 'name' => 'contact', 'required' => true],
        );
        $this->assertSame('contact', $kept['contentTypes'][0]['fields'][1]['targetField']);

        // A uid is made from a text field only, so it no longer is from a number.
        $this->assertSame([
            ['type' => 'integer', 'name' => 'title', 'localized' => false],
            ['type' => 'uid', 'name' => 'slug'],
        ], $after['contentTypes'][0]['fields']);
    }

    public function test_a_field_kept_outside_its_table_cannot_change_type(): void
    {
        $ir = ['contentTypes' => [
            ['name' => 'Page', 'kind' => 'collection', 'fields' => [['type' => 'relation', 'name' => 'author', 'relationKind' => 'manyToOne', 'target' => 'Page']]],
        ], 'components' => []];

        $this->expectException(\InvalidArgumentException::class);
        $this->expectExceptionMessage('Delete it and add a new field');
        \App\Support\ContentTypeBuilderSchema::updateField($ir, 'contentType:Page', 'author', ['kind' => 'text', 'name' => 'author']);
    }

    public function test_a_column_value_converts_to_another_type_or_is_emptied(): void
    {
        $convert = \App\Support\ColumnConversion::convert(...);
        $this->assertSame(12, $convert('12', 'string(255)', 'integer'));
        $this->assertSame(8, $convert('7.6', 'string(255)', 'integer'));
        $this->assertNull($convert('many', 'string(255)', 'integer'));
        $this->assertSame(9007199254740993, $convert('9007199254740993', 'text', 'bigInteger'));
        $this->assertNull($convert('92233720368547758070', 'text', 'bigInteger'));
        $this->assertSame(3.25, $convert('3.25', 'string(255)', 'decimal(8, 2)'));
        $this->assertSame('true', $convert(1, 'boolean', 'string(255)'));
        $this->assertSame('false', $convert(false, 'boolean', 'text'));
        $this->assertTrue($convert('yes', 'string(255)', 'boolean'));
        $this->assertFalse($convert(0, 'integer', 'boolean'));
        $this->assertNull($convert('maybe', 'string(255)', 'boolean'));
        $this->assertSame('2024-03-01', $convert('2024-03-01 10:00:00', 'string(255)', 'date'));
        $this->assertSame('2024-03-01 10:00:00', $convert('2024-03-01T10:00:00', 'text', 'dateTime'));
        $this->assertSame('10:30:00', $convert('10:30', 'string(255)', 'time'));
        $this->assertNull($convert('not a date', 'text', 'dateTime'));
        $this->assertSame('"hello"', $convert('hello', 'text', 'json'));
        $this->assertSame('{"a":1}', $convert('{"a":1}', 'text', 'json'));
        $this->assertSame('{"a":1}', $convert('{"a":1}', 'json', 'text'));
        $this->assertSame('42', $convert(42, 'integer', 'string(255)'));
        $this->assertSame('abc', $convert('abcdef', 'text', 'string(3)'));
        $this->assertNull($convert(null, 'text', 'integer'));
        // What the new column cannot hold is emptied, never handed to a database that would refuse it.
        $this->assertNull($convert('1e20', 'text', 'bigInteger'));
        $this->assertNull($convert('3000000000', 'text', 'integer'));
        $this->assertSame(3000000000, $convert('3000000000', 'text', 'integer unsigned'));
        $this->assertNull($convert('-5', 'text', 'integer unsigned'));
        $this->assertNull($convert('123456789', 'text', 'decimal(8, 2)'));
        $this->assertSame(1.24, $convert('1.235', 'text', 'decimal(8, 2)'));
        $this->assertNull($convert(3, 'integer', 'enum(a|b)'));
        $this->assertSame('b', $convert('b', 'text', 'enum(a|b)'));
        $this->assertSame('abcdefghij', $convert('abcdefghijkl', 'text', 'char(10)'));
        // Only a date written as ISO 8601 or SQL write one is read as one.
        foreach (['2024', 'a', 'tomorrow', 'Monday', '10:30'] as $notADate) {
            $this->assertNull($convert($notADate, 'text', 'dateTime'), $notADate);
        }
        $this->assertSame('2024-03-01 09:00:00', $convert('2024-03-01T10:00:00+01:00', 'text', 'dateTime'));
        $this->assertSame('2024-03-01 10:00:00', $convert('2024-03-01T10:00:00.000Z', 'text', 'dateTime'));
        // An empty text is no answer, and a number is true unless it is zero, written or not.
        $this->assertNull($convert('', 'text', 'boolean'));
        $this->assertTrue($convert('2', 'text', 'boolean'));
        $this->assertFalse($convert('0.0', 'text', 'boolean'));
    }

    public function test_the_schema_sync_converts_a_column_changed_to_another_group(): void
    {
        // As if "views" had been a short text when the database was last synced.
        Schema::table('posts', function ($table): void {
            $table->string('views')->nullable()->change();
        });
        foreach (['twelve' => '12', 'many' => 'many', 'rounded' => '7.6', 'none' => null] as $title => $views) {
            Post::create(['title' => $title, 'views' => $views]);
        }
        $types = \App\Support\CamisSchemaSync::columnTypesPath(DB::connection());
        @mkdir(dirname($types), 0777, true);
        file_put_contents($types, json_encode(['posts' => ['views' => 'string(255)']]));

        try {
            $this->assertSame(0, Artisan::call('camis:schema-sync', ['--force' => true]));

            $this->assertStringContainsString('converted posts.views from string(255) to integer', Artisan::output());
            $this->assertSame('integer', Schema::getColumnType('posts', 'views'));
            $this->assertSame(
                ['many' => null, 'none' => null, 'rounded' => 8, 'twelve' => 12],
                DB::table('posts')->orderBy('title')->pluck('views', 'title')->map(fn ($views) => $views === null ? null : (int) $views)->all(),
            );
            $this->assertNotContains('camis_converting_views', Schema::getColumnListing('posts'));
        } finally {
            @unlink($types);
        }
    }

    public function test_the_schema_sync_keeps_the_data_while_columns_and_tables_follow_the_migrations(): void
    {
        $tag = Tag::create(['label' => 'kept']);
        Schema::table('tags', function ($table): void {
            $table->string('obsolete')->nullable();
        });
        Schema::create('widgets', function ($table): void {
            $table->id();
        });
        DB::table('migrations')->insert(['migration' => '0001_01_02_000099_create_widgets_table', 'batch' => 1]);
        // A type added before Tag renumbers Tag's migration.
        DB::table('migrations')->where('migration', 'like', '%_create_tags_table')->update(['migration' => '0001_01_02_000077_create_tags_table']);

        $this->assertSame(0, Artisan::call('camis:schema-sync', ['--force' => true]));

        $this->assertFalse(Schema::hasColumn('tags', 'obsolete'));
        $this->assertFalse(Schema::hasTable('widgets'));
        $this->assertSame('kept', $tag->fresh()?->label);
        $files = array_map(fn (string $path): string => basename($path, '.php'), glob(database_path('migrations/0001_01_0[23]_*.php')) ?: []);
        $recorded = DB::table('migrations')->where('migration', 'like', '0001_01_0%')->where('migration', 'not like', '0001_01_01_%')->pluck('migration')->all();
        sort($files);
        sort($recorded);
        $this->assertSame($files, $recorded);
    }

    public function test_the_schema_sync_gives_a_table_back_the_columns_it_lacks(): void
    {
        Tag::create(['label' => 'kept']);
        Schema::table('tags', function ($table): void {
            $table->dropColumn('label');
        });

        Artisan::call('camis:schema-sync', ['--force' => true]);

        $this->assertTrue(Schema::hasColumn('tags', 'label'));
        $this->assertSame(1, Tag::query()->count());
        $this->assertStringContainsString('added tags.label', Artisan::output());
    }

    public function test_the_schema_sync_changes_a_column_whose_declared_type_changed(): void
    {
        $tag = Tag::create(['label' => 'kept']);
        // As if "label" had been a long text when the database was last synced.
        Schema::table('tags', function ($table): void {
            $table->text('label')->nullable()->change();
        });
        // Kept per database, so another connection's sync (a test's, another driver's) is not taken for this one's.
        $types = \App\Support\CamisSchemaSync::columnTypesPath(DB::connection());
        @mkdir(dirname($types), 0777, true);
        file_put_contents($types, json_encode(['tags' => ['label' => 'text']]));

        try {
            $this->assertSame(0, Artisan::call('camis:schema-sync', ['--force' => true]));

            $this->assertStringContainsString('changed tags.label', Artisan::output());
            $this->assertSame('varchar', Schema::getColumnType('tags', 'label'));
            $this->assertSame('kept', $tag->fresh()?->label);
            // What the sync declared is what the next one compares with.
            $recorded = json_decode((string) file_get_contents($types), true);
            $this->assertSame('string(255)', $recorded['tags']['label']);
            $this->assertSame('bigInteger unsigned', $recorded['posts']['author_id']);
            // A column a generated alteration adds is recorded too.
            $this->assertSame('string(255)', $recorded['users']['username']);
            Artisan::call('camis:schema-sync', ['--force' => true]);
            $this->assertStringNotContainsString('changed tags.label', Artisan::output());
        } finally {
            @unlink($types);
        }
    }

    public function test_a_display_name_is_humanized_as_the_ir_humanizes_it(): void
    {
        // As ir-core does, so the builder and the Strapi importer agree on when a display name is
        // the derived one.
        $this->assertSame('Seo Meta', \App\Support\ContentTypeBuilderSchema::humanize('SeoMeta'));
        $this->assertSame('SEOMeta', \App\Support\ContentTypeBuilderSchema::humanize('SEOMeta'));
    }

    public function test_the_schema_sync_refuses_to_run_outside_development_unforced(): void
    {
        $this->assertSame(1, Artisan::call('camis:schema-sync'));
        $this->assertStringContainsString('--force', Artisan::output());
    }
}
