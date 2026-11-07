<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Pages\EmailSettings;
use App\Filament\Pages\MediaLibrarySettings;
use App\Filament\Pages\SettingsOverview;
use App\Filament\Widgets\StrapiEntries;
use App\Filament\Widgets\StrapiLastEditedEntries;
use App\Filament\Widgets\StrapiLastPublishedEntries;
use App\Filament\Widgets\StrapiProjectStatistics;
use App\Http\Serializers\PostSerializer;
use App\Models\Author;
use App\Models\Post;
use App\Models\User;
use App\Support\StrapiDocuments;
use App\Support\StrapiExport;
use App\Support\StrapiHomepage;
use App\Support\StrapiSettings;
use App\Support\StrapiUpload;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Mail;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * Strapi's Home (the homepage widgets) and Settings › Overview, Media Library and Email on the
 * strapi-api fixture: the widgets show only what the user may read, the Media Library settings
 * change what an upload stores, and the Email page sends Strapi's test email. CI copies this into
 * the scaffolded app's tests/Feature.
 */
class SettingsPagesTest extends TestCase
{
    use RefreshDatabase;

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

    private function published(string $title): Post
    {
        $draft = Post::create(['title' => $title]);
        StrapiDocuments::publish($draft, PostSerializer::class);

        return $draft->fresh();
    }

    public function test_the_homepage_lists_the_last_edited_and_published_entries_the_user_may_read(): void
    {
        $this->login(['post.read']);
        $this->published('Published post');
        $modified = $this->published('Modified post');
        $this->travel(1)->minutes();
        $modified->update(['title' => 'Modified post, edited']);
        Post::create(['title' => 'Draft post']);
        Author::create(['name' => 'Hidden author']);

        $edited = StrapiHomepage::lastEdited();
        $this->assertSame(['Modified post, edited', 'Draft post', 'Published post'], array_column(array_values($edited), 'title'));
        $this->assertSame(['Modified', 'Draft', 'Published'], array_column(array_values($edited), 'status'));
        $this->assertSame(['Post'], array_values(array_unique(array_column($edited, 'contentType'))));
        Livewire::test(StrapiLastEditedEntries::class)
            ->assertSee('Last edited entries')
            ->assertSee('Modified post, edited')
            ->assertDontSee('Hidden author');

        // The published version's title, linking to the draft's edit page.
        $published = array_values(StrapiHomepage::lastPublished());
        $this->assertEqualsCanonicalizing(['Published post', 'Modified post'], array_column($published, 'title'));
        $this->assertStringEndsWith("/posts/{$modified->getKey()}/edit", (string) collect($published)->firstWhere('title', 'Modified post')['url']);
        Livewire::test(StrapiLastPublishedEntries::class)->assertSee('Published post');

        // One draft, one modified, one published: each document counted once.
        $this->assertSame(['draft' => 1, 'published' => 1, 'modified' => 1], StrapiHomepage::counts());
        Livewire::test(StrapiEntries::class)->assertSee('Modified');
    }

    public function test_the_homepage_shows_nothing_the_user_may_not_read(): void
    {
        $this->login([]);
        $this->published('Secret');
        $this->assertSame([], StrapiHomepage::lastEdited());
        $this->assertSame(['draft' => 0, 'published' => 0, 'modified' => 0], StrapiHomepage::counts());
        $this->assertFalse(StrapiEntries::canView());
        $this->assertFalse(StrapiLastEditedEntries::canView());
    }

    public function test_project_statistics_count_what_strapi_counts(): void
    {
        $this->login(['user.update']);
        $statistics = StrapiHomepage::statistics();
        $this->assertSame(['assets', 'contentTypes', 'components', 'locales', 'admins', 'webhooks', 'apiTokens'], array_keys($statistics));
        $this->assertSame(count(StrapiHomepage::TYPES), $statistics['contentTypes']);
        Livewire::test(StrapiProjectStatistics::class)->assertSee('Project statistics')->assertSee('Content-Types');
    }

    public function test_the_overview_shows_the_applications_details(): void
    {
        $this->login(['user.update']);
        Livewire::test(SettingsOverview::class)
            ->assertSee('Overview')
            ->assertSee(app()->version())
            ->assertSee(PHP_VERSION);
    }

    public function test_media_library_settings_change_what_an_upload_stores(): void
    {
        $this->login(['user.update']);
        $this->assertSame(StrapiUpload::DEFAULT_SETTINGS, StrapiUpload::settings());
        $wide = StrapiUpload::store(UploadedFile::fake()->image('wide.png', 1200, 800), []);
        $this->assertSame(['thumbnail', 'large', 'medium', 'small'], array_keys($wide->formats));

        Livewire::test(MediaLibrarySettings::class)
            ->assertFormSet(['settings.responsiveDimensions' => true, 'settings.sizeOptimization' => true])
            ->fillForm(['settings.responsiveDimensions' => false, 'settings.autoOrientation' => true])
            ->call('save')
            ->assertHasNoFormErrors();
        // Only the toggles change; Strapi's other settings are kept.
        $this->assertSame(['sizeOptimization' => true, 'responsiveDimensions' => false, 'autoOrientation' => true, 'aiMetadata' => true], StrapiUpload::settings());

        // The thumbnail stays, as Strapi's does; the responsive formats are not made.
        $again = StrapiUpload::store(UploadedFile::fake()->image('again.png', 1200, 800), []);
        $this->assertSame(['thumbnail'], array_keys($again->formats));
        $this->assertSame([1200, 800], [$again->width, $again->height]);
    }

    public function test_the_media_library_settings_travel_in_an_export(): void
    {
        $this->login(['user.update']);
        StrapiSettings::merge(StrapiUpload::SETTINGS_KEY, ['sizeOptimization' => false]);
        $directory = sys_get_temp_dir().'/camis-settings-'.uniqid();
        mkdir($directory);
        $written = StrapiExport::write($directory.'/export', StrapiExport::stages(null, ['content', 'files']), false, null);
        $tar = new \PharData($written['path']);
        $lines = '';
        foreach (new \RecursiveIteratorIterator($tar) as $file) {
            if (str_contains($file->getPathname(), 'configuration')) {
                $lines .= file_get_contents($file->getPathname());
            }
        }
        $this->assertStringContainsString('"key":"plugin_upload_settings","value":{"sizeOptimization":false,"responsiveDimensions":true,"autoOrientation":false,"aiMetadata":true}', $lines);
    }

    public function test_the_email_page_shows_the_settings_and_sends_strapis_test_email(): void
    {
        config(['mail.default' => 'array', 'mail.from.address' => 'hello@example.test', 'camis.email.default_reply_to' => 'reply@example.test']);
        $this->login(['user.update']);
        Livewire::test(EmailSettings::class)
            ->assertSee('hello@example.test')
            ->assertSee('reply@example.test')
            ->assertSee('array')
            ->fillForm(['to' => 'me@example.test'], 'testForm')
            ->call('sendTest')
            ->assertNotified('Email test succeeded, check the me@example.test mailbox');

        $sent = Mail::mailer('array')->getSymfonyTransport()->messages();
        $this->assertCount(1, $sent);
        $email = $sent->first()->getOriginalMessage();
        $this->assertSame('Strapi test mail to: me@example.test', $email->getSubject());
        $this->assertSame('hello@example.test', $email->getFrom()[0]->getAddress());
        $this->assertSame('reply@example.test', $email->getReplyTo()[0]->getAddress());
        $this->assertStringContainsString('with the array provider', (string) $email->getTextBody());
    }

    public function test_settings_pages_need_the_settings_grant(): void
    {
        $this->login(['post.read']);
        foreach ([SettingsOverview::class, MediaLibrarySettings::class, EmailSettings::class] as $page) {
            $this->assertFalse($page::canAccess(), $page);
            Livewire::test($page)->assertForbidden();
        }
    }
}
