<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Models\StrapiApiToken;
use App\Models\StrapiTransferToken;
use App\Support\StrapiApiTokens;
use App\Support\StrapiTransferTokens;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

/**
 * `php artisan strapi:import-tokens`: the API and transfer tokens of strapi-php's database
 * (transfer/strapi-php-tokens.sql), whose keys token-import-vectors.json uses. CI copies this into
 * the scaffolded app's tests/Feature; what the imported tokens are let do is the vectors' part.
 */
class TokenImportTest extends TestCase
{
    use RefreshDatabase;

    /** strapi-php's .env.example values, which its tokens were made under. */
    private const SECRET = 'tobemodified';

    private string $database;

    protected function setUp(): void
    {
        parent::setUp();
        config(['camis.api_tokens.salt' => self::SECRET, 'camis.transfer_tokens.salt' => self::SECRET]);
        $this->database = tempnam(sys_get_temp_dir(), 'strapi-tokens');
        $pdo = new \PDO('sqlite:'.$this->database);
        $pdo->exec((string) file_get_contents(self::fixture('strapi-php-tokens.sql')));
    }

    protected function tearDown(): void
    {
        unlink($this->database);
        parent::tearDown();
    }

    private static function fixture(string $name): string
    {
        $directory = getenv('CAMIS_TRANSFER_FIXTURES') ?: base_path('../packages/adapter-filament/src/strapi-api/__fixtures__/transfer');

        return $directory.'/'.$name;
    }

    /** A key token-import-vectors.json sends, by the step that sends it. */
    private static function key(string $step): string
    {
        $vectors = json_decode((string) file_get_contents(self::fixture('token-import-vectors.json')), true);
        foreach ($vectors['steps'] as $vector) {
            if ($vector['name'] === $step) {
                return $vector['bearer'];
            }
        }
        throw new \RuntimeException("no step {$step}");
    }

    public function test_every_token_keeps_its_hash_type_actions_and_dates(): void
    {
        $this->artisan('strapi:import-tokens', ['--database' => $this->database, '--encryption-key' => self::SECRET, '--force' => true])
            ->expectsTable(['Tokens', 'Count'], [['API tokens', 6], ['Transfer tokens', 1]])
            ->assertSuccessful();

        $this->assertSame(['books', 'Full Access', 'lapsed', 'Read Only', 'reader', 'seeder'], StrapiApiToken::query()->orderByRaw('lower(name)')->pluck('name')->all());
        $books = StrapiApiToken::query()->where('name', 'books')->sole();
        $this->assertSame('custom', $books->type);
        $this->assertSame(['api::book.book.find', 'api::book.book.findOne'], $books->permissions);
        $this->assertSame(StrapiApiTokens::hash(self::key('a custom token lists what it was given')), $books->access_key);
        $reader = StrapiApiToken::query()->where('name', 'reader')->sole();
        $this->assertSame(604800000, $reader->lifespan);
        $this->assertSame('2099-01-01', $reader->expires_at?->format('Y-m-d'));
        $this->assertTrue(StrapiApiToken::query()->where('name', 'lapsed')->sole()->expires_at?->isPast());

        $puller = StrapiTransferToken::query()->sole();
        $this->assertSame(['name' => 'puller', 'permissions' => ['pull']], ['name' => $puller->name, 'permissions' => $puller->permissions]);
        $this->assertSame(StrapiTransferTokens::hash(self::key('a transfer token strapi-php made reaches the pull runner')), $puller->access_key);
    }

    public function test_with_strapis_encryption_key_the_admin_can_show_a_key_again(): void
    {
        $this->artisan('strapi:import-tokens', ['--database' => $this->database, '--encryption-key' => self::SECRET, '--force' => true])->assertSuccessful();

        $this->assertSame(self::key('a full-access token strapi-php made writes'), StrapiApiTokens::reveal(StrapiApiToken::query()->where('name', 'seeder')->sole()));
    }

    public function test_without_it_a_key_still_verifies_but_is_not_shown(): void
    {
        $this->artisan('strapi:import-tokens', ['--database' => $this->database, '--force' => true])
            ->expectsOutputToContain('API token seeder: its key works, but the admin cannot show it again')
            ->assertSuccessful();

        $seeder = StrapiApiToken::query()->where('name', 'seeder')->sole();
        $this->assertNull(StrapiApiTokens::reveal($seeder));
        $this->assertSame(StrapiApiTokens::hash(self::key('a full-access token strapi-php made writes')), $seeder->access_key);
    }

    public function test_a_token_named_as_one_here_replaces_it_once_confirmed(): void
    {
        StrapiApiTokens::create(['name' => 'seeder', 'type' => 'read-only']);

        $this->artisan('strapi:import-tokens', ['--database' => $this->database])
            ->expectsConfirmation('These tokens will replace the ones of the same name here: seeder. Proceed?', 'no')
            ->assertFailed();
        $this->assertSame('read-only', StrapiApiToken::query()->where('name', 'seeder')->sole()->type);

        $this->artisan('strapi:import-tokens', ['--database' => $this->database])
            ->expectsConfirmation('These tokens will replace the ones of the same name here: seeder. Proceed?', 'yes')
            ->assertSuccessful();
        $this->assertSame('full-access', StrapiApiToken::query()->where('name', 'seeder')->sole()->type);
    }

    public function test_an_admin_token_is_reported_rather_than_made_a_content_api_one(): void
    {
        (new \PDO('sqlite:'.$this->database))->exec("UPDATE strapi_api_tokens SET kind = 'admin' WHERE name = 'books'");

        $this->artisan('strapi:import-tokens', ['--database' => $this->database, '--force' => true])
            ->expectsOutputToContain('Not imported: API token books (an admin token')
            ->assertSuccessful();
        $this->assertFalse(StrapiApiToken::query()->where('name', 'books')->exists());
    }

    public function test_a_database_without_strapis_tables_is_refused(): void
    {
        $empty = tempnam(sys_get_temp_dir(), 'empty');
        new \PDO('sqlite:'.$empty);

        $this->artisan('strapi:import-tokens', ['--database' => $empty])
            ->expectsOutputToContain('has no strapi_api_tokens table')
            ->assertFailed();
        unlink($empty);
    }
}
