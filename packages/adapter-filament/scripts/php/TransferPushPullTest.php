<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Support\StrapiTransferArchives;
use App\Support\StrapiTransferTokens;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Transfers over plain HTTP, as strapi-plugin-camis makes them: a push token uploads a Strapi
 * export archive in chunks and applies it, a pull token downloads this app's archive. The archive
 * is strapi-php's, as the strapi:import CI step reads it. CI copies this into tests/Feature.
 */
class TransferPushPullTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
    }

    protected function tearDown(): void
    {
        foreach (['pushes', 'pulls'] as $sub) {
            foreach (glob(storage_path("app/private/strapi-transfer-{$sub}/*")) ?: [] as $path) {
                unlink($path);
            }
        }
        parent::tearDown();
    }

    private static function fixture(string $name): string
    {
        $directory = getenv('CAMIS_TRANSFER_FIXTURES') ?: base_path('../packages/adapter-filament/src/strapi-api/__fixtures__/transfer');

        return (string) file_get_contents($directory.'/'.$name);
    }

    private static function key(array $permissions): string
    {
        return StrapiTransferTokens::create(['name' => implode('+', $permissions).' '.bin2hex(random_bytes(4)), 'permissions' => $permissions])['accessKey'];
    }

    private function as(string $key): static
    {
        return $this->withHeader('Authorization', "Bearer {$key}");
    }

    private function putChunk(string $key, string $id, int $offset, string $bytes): TestResponse
    {
        return $this->as($key)->call('PUT', "/admin/transfer/push/{$id}?offset={$offset}", [], [], [], [
            'CONTENT_TYPE' => 'application/octet-stream',
            'HTTP_AUTHORIZATION' => "Bearer {$key}",
        ], $bytes);
    }

    /** @return string the push's id, with the whole archive sent */
    private function upload(string $key, string $archive, int $chunk = 4096): string
    {
        $id = (string) $this->as($key)->postJson('/admin/transfer/push')->assertCreated()->json('data.id');
        for ($offset = 0; $offset < strlen($archive); $offset += $chunk) {
            $this->putChunk($key, $id, $offset, substr($archive, $offset, $chunk))
                ->assertOk()->assertJsonPath('data.size', min($offset + $chunk, strlen($archive)));
        }

        return $id;
    }

    public function test_a_pushed_archive_is_checked_then_replaces_the_content(): void
    {
        $key = self::key(['push']);
        $id = $this->upload($key, self::fixture('strapi-php-export.tar.gz'));
        $this->as($key)->postJson("/admin/transfer/push/{$id}/check")->assertOk()->assertExactJson(['data' => ['diffs' => []]]);
        $this->assertDatabaseMissing('users', ['username' => 'alice']);

        $applied = $this->as($key)->postJson("/admin/transfer/push/{$id}/apply")->assertOk();
        $this->assertGreaterThan(0, array_sum($applied->json('data.counts')));
        $this->assertDatabaseHas('users', ['username' => 'alice']);
        // Applied once: the upload is gone, and the Data transfer page never listed it.
        $this->as($key)->postJson("/admin/transfer/push/{$id}/apply")->assertNotFound();
        $this->assertSame([], StrapiTransferArchives::names());
    }

    public function test_a_chunk_sent_twice_or_out_of_order_is_refused_with_the_size_received(): void
    {
        $key = self::key(['push']);
        $id = (string) $this->as($key)->postJson('/admin/transfer/push')->json('data.id');
        $this->putChunk($key, $id, 0, 'abc')->assertOk()->assertJsonPath('data.size', 3);
        $this->putChunk($key, $id, 0, 'abc')->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError')->assertJsonPath('error.details.size', 3);
        $this->putChunk($key, $id, 9, 'abc')->assertStatus(400)->assertJsonPath('error.details.size', 3);
    }

    public function test_only_and_exclude_choose_what_is_applied(): void
    {
        $key = self::key(['push']);
        $id = $this->upload($key, self::fixture('strapi-php-export.tar.gz'), 1 << 20);
        $this->as($key)->postJson("/admin/transfer/push/{$id}/apply", ['only' => ['content'], 'exclude' => ['files']])
            ->assertStatus(400)->assertJsonPath('error.name', 'ValidationError');
        $this->as($key)->postJson("/admin/transfer/push/{$id}/apply", ['only' => ['nonsense']])->assertStatus(400);
        $this->as($key)->postJson("/admin/transfer/push/{$id}/apply", ['exclude' => ['content']])->assertOk();
        $this->assertDatabaseMissing('users', ['username' => 'alice']);
    }

    public function test_something_that_is_not_an_archive_is_refused_before_anything_is_replaced(): void
    {
        $key = self::key(['push']);
        $id = $this->upload($key, 'not an archive');
        $this->as($key)->postJson("/admin/transfer/push/{$id}/check")->assertStatus(400)->assertJsonPath('error.name', 'ValidationError');
        $this->as($key)->postJson("/admin/transfer/push/{$id}/apply")->assertStatus(400);
    }

    public function test_an_aborted_push_is_dropped(): void
    {
        $key = self::key(['push']);
        $id = $this->upload($key, 'partial');
        $this->as($key)->deleteJson("/admin/transfer/push/{$id}")->assertNoContent();
        $this->putChunk($key, $id, 7, 'more')->assertNotFound();
    }

    public function test_push_needs_a_push_token_and_pull_a_pull_token(): void
    {
        $this->postJson('/admin/transfer/push')->assertUnauthorized()->assertJsonPath('error.name', 'UnauthorizedError');
        $this->as('not-a-key')->postJson('/admin/transfer/push')->assertUnauthorized();
        $this->as(self::key(['pull']))->postJson('/admin/transfer/push')->assertForbidden()->assertJsonPath('error.name', 'ForbiddenError');
        $this->as(self::key(['push']))->get('/admin/transfer/pull')->assertForbidden();
        $push = self::key(['push']);
        $id = $this->upload($push, 'x');
        $this->as(self::key(['pull']))->postJson("/admin/transfer/push/{$id}/apply")->assertForbidden();
        $this->assertDatabaseMissing('users', ['username' => 'alice']);
    }

    public function test_a_pulled_archive_is_this_apps_data_and_reads_back_in(): void
    {
        $push = self::key(['push']);
        $id = $this->upload($push, self::fixture('strapi-php-export.tar.gz'), 1 << 20);
        $this->as($push)->postJson("/admin/transfer/push/{$id}/apply")->assertOk();

        $pull = self::key(['pull']);
        $response = $this->as($pull)->get('/admin/transfer/pull?exclude=files')->assertOk()->assertDownload('camis-export.tar.gz');
        $this->assertGreaterThan(0, array_sum((array) json_decode((string) $response->headers->get('X-Camis-Counts'), true)));
        ob_start();
        $response->baseResponse->sendContent();
        $archive = (string) ob_get_clean();
        $this->assertStringStartsWith("\x1f\x8b", $archive);
        $this->assertSame([], glob(storage_path('app/private/strapi-transfer-pulls/*')) ?: []);
        $this->assertSame([], StrapiTransferArchives::names());

        // What was pulled pushes back in unchanged.
        \App\Models\User::query()->where('username', 'alice')->delete();
        $again = $this->upload($push, $archive, 1 << 20);
        $this->as($push)->postJson("/admin/transfer/push/{$again}/check")->assertExactJson(['data' => ['diffs' => []]]);
        $this->as($push)->postJson("/admin/transfer/push/{$again}/apply")->assertOk();
        $this->assertDatabaseHas('users', ['username' => 'alice']);
    }

    public function test_pull_refuses_an_unknown_data_type(): void
    {
        $this->as(self::key(['pull']))->get('/admin/transfer/pull?only=nonsense')->assertStatus(400)->assertJsonPath('error.name', 'ValidationError');
    }
}
