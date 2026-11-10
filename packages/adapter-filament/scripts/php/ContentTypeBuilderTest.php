<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Pages\ContentTypeBuilder;
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
        $user = User::factory()->create(['username' => 'admin']);
        $user->givePermissionTo($permissions);
        $this->actingAs($user);
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

        // The options the dialog does not show are kept.
        $this->assertSame(['timestamps' => true, 'softDelete' => false], $this->type('Post')['options']);
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
        $this->assertSame(['name' => 'CallToAction', 'names' => ['group' => 'blocks'], 'fields' => [['type' => 'string', 'name' => 'label']]], $component);
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

    public function test_the_schema_sync_refuses_to_run_outside_development_unforced(): void
    {
        $this->assertSame(1, Artisan::call('camis:schema-sync'));
        $this->assertStringContainsString('--force', Artisan::output());
    }
}
