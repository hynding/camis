<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Filament\Pages\DataTransfer;
use App\Models\User;
use App\Support\StrapiTransferArchives;
use Filament\Facades\Filament;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Livewire\Livewire;
use Tests\TestCase;

/**
 * The admin's Data transfer page: strapi:export and strapi:import for a host with no shell. The
 * archive is strapi-php's, as the strapi:import CI step reads it. CI copies this into the
 * scaffolded app's tests/Feature.
 */
class DataTransferTest extends TestCase
{
    use RefreshDatabase;

    private const KEY = 'camis-fixture-key';

    private function login(array $permissions): User
    {
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        foreach ($permissions as $permission) {
            \Spatie\Permission\Models\Permission::findOrCreate($permission);
        }
        $user = User::factory()->create(['username' => 'admin', 'email' => 'admin@example.test']);
        $user->givePermissionTo($permissions);
        $this->actingAs($user);
        Filament::setCurrentPanel(Filament::getPanel('admin'));

        return $user;
    }

    private static function fixture(string $name): string
    {
        $directory = getenv('CAMIS_TRANSFER_FIXTURES') ?: base_path('../packages/adapter-filament/src/strapi-api/__fixtures__/transfer');

        return $directory.'/'.$name;
    }

    protected function tearDown(): void
    {
        foreach (glob(StrapiTransferArchives::directory().'/*') ?: [] as $path) {
            unlink($path);
        }
        parent::tearDown();
    }

    public function test_an_uploaded_archive_replaces_the_content_once_confirmed(): void
    {
        $this->login(['user.update']);
        $upload = UploadedFile::fake()->createWithContent('strapi-php-export.tar.gz.enc', (string) file_get_contents(self::fixture('strapi-php-export.tar.gz.enc')));

        Livewire::test(DataTransfer::class)
            ->fillForm(['upload' => $upload, 'key' => self::KEY], 'importForm')
            ->callAction('import')
            ->assertNotified('Import process has been completed successfully!');

        $this->assertDatabaseHas('users', ['username' => 'alice']);
        // The admin's own account, which the archive lacks, is kept; the upload is not.
        $this->assertDatabaseHas('users', ['username' => 'admin']);
        $this->assertSame([], StrapiTransferArchives::names());
    }

    public function test_an_archive_put_on_the_server_by_ftp_is_picked_from_a_list(): void
    {
        $this->login(['user.update']);
        copy(self::fixture('strapi-php-export.tar.gz'), StrapiTransferArchives::path('strapi-php-export.tar.gz'));

        Livewire::test(DataTransfer::class)
            ->fillForm(['stored' => 'strapi-php-export.tar.gz', 'exclude' => ['files']], 'importForm')
            ->callAction('import')
            ->assertNotified('Import process has been completed successfully!');

        $this->assertDatabaseHas('users', ['username' => 'alice']);
        $this->assertSame(['strapi-php-export.tar.gz'], StrapiTransferArchives::names());
    }

    public function test_a_wrong_key_is_reported_and_nothing_is_replaced(): void
    {
        $this->login(['user.update']);
        copy(self::fixture('strapi-php-export.tar.gz.enc'), StrapiTransferArchives::path('strapi-php-export.tar.gz.enc'));

        Livewire::test(DataTransfer::class)
            ->fillForm(['stored' => 'strapi-php-export.tar.gz.enc', 'key' => 'wrong'], 'importForm')
            ->callAction('import')
            ->assertNotified('Import process failed');

        $this->assertDatabaseMissing('users', ['username' => 'alice']);
    }

    public function test_an_export_downloads_through_a_signed_link(): void
    {
        $this->login(['user.update']);
        $page = Livewire::test(DataTransfer::class)
            ->fillForm(['encrypt' => true, 'key' => self::KEY, 'compress' => true], 'exportForm')
            ->call('export')
            ->assertNotified('Export process has been completed successfully!');

        $url = (string) $page->effects['redirect'];
        $this->assertStringContainsString('/admin/data-transfer/export_', $url);
        $this->assertStringContainsString('.tar.gz.enc?', $url);
        $this->assertStringContainsString('signature=', $url);

        $this->app['auth']->forgetGuards();
        $this->get(preg_replace('/signature=[0-9a-f]+/', 'signature=0', $url))->assertForbidden();
        // Removed once sent, which the test client does not do.
        $this->get($url)->assertOk()->assertDownload(basename((string) parse_url($url, PHP_URL_PATH)));
    }

    public function test_the_export_reads_back_in(): void
    {
        $this->login(['user.update']);
        copy(self::fixture('strapi-php-export.tar.gz'), StrapiTransferArchives::path('in.tar.gz'));
        Livewire::test(DataTransfer::class)
            ->fillForm(['stored' => 'in.tar.gz'], 'importForm')
            ->callAction('import');

        $url = (string) Livewire::test(DataTransfer::class)
            ->fillForm(['encrypt' => false, 'compress' => true], 'exportForm')
            ->call('export')->effects['redirect'];
        $name = basename((string) parse_url($url, PHP_URL_PATH));
        $this->assertMatchesRegularExpression('/^export_\d{14}\.tar\.gz$/', $name);

        Livewire::test(DataTransfer::class)
            ->fillForm(['stored' => $name], 'importForm')
            ->callAction('import')
            ->assertNotified('Import process has been completed successfully!');
        $this->assertDatabaseHas('users', ['username' => 'alice']);
    }

    public function test_the_page_renders_both_forms(): void
    {
        $this->login(['user.update']);
        Livewire::test(DataTransfer::class)->assertOk()->assertSee('Export')->assertSee('Or an archive already on the server');
    }

    public function test_the_page_is_out_of_reach_without_the_grant_to_change_accounts(): void
    {
        $this->login(['user.read']);
        Livewire::test(DataTransfer::class)->assertForbidden();
    }

    public function test_a_name_that_is_a_path_is_refused(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        StrapiTransferArchives::path('../.env');
    }
}
