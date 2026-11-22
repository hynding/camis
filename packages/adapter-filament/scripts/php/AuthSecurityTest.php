<?php

declare(strict_types=1);

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Where camis is stricter than Strapi on its credential routes: every route that checks a
 * password is throttled, and a throttled answer keeps its Retry-After. CI copies this into the
 * scaffolded app's tests/Feature and runs it with uncached routes and a low
 * CAMIS_AUTH_THROTTLE_PER_MINUTE, since the rate is read when routes/api.php is loaded.
 */
class AuthSecurityTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
    }

    private static function limit(): int
    {
        return (int) config('camis.auth_throttle_per_minute');
    }

    private function register(string $username): string
    {
        return (string) $this->postJson('/api/auth/local/register', ['username' => $username, 'email' => "{$username}@example.test", 'password' => 'secret1'])
            ->assertOk()->json('jwt');
    }

    /**
     * Repeats a request until it is throttled, which must happen within the limit: the credential
     * routes share one bucket per client, so an earlier request may already have used a turn.
     * Each answer before is $expected; the throttled one is in Strapi's envelope, with its wait.
     *
     * @param callable(): TestResponse $request
     */
    private static function assertThrottled(callable $request, int $expected): void
    {
        for ($i = 0; $i <= self::limit(); $i++) {
            $response = $request();
            if ($response->status() === 429) {
                $response->assertJsonPath('error.status', 429)->assertJsonPath('data', null);
                self::assertNotNull($response->headers->get('Retry-After'));

                return;
            }
            $response->assertStatus($expected);
        }
        self::fail('Not throttled within '.self::limit().' requests');
    }

    public function test_a_password_sign_in_through_the_provider_callback_route_is_throttled(): void
    {
        self::assertThrottled(fn (): TestResponse => $this->json('GET', '/api/auth/local/callback', ['identifier' => 'nobody', 'password' => 'wrong']), 400);
    }

    /** A stolen access token must not buy unlimited guesses of the current password. */
    public function test_a_password_change_is_throttled_per_account(): void
    {
        $jwt = $this->register('alice');
        $guess = ['currentPassword' => 'wrong', 'password' => 'secret2', 'passwordConfirmation' => 'secret2'];
        self::assertThrottled(fn (): TestResponse => $this->withToken($jwt)->postJson('/api/auth/change-password', $guess), 400);
    }
}
