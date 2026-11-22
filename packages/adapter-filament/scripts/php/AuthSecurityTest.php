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

    /** The request the limit was reached with is refused in Strapi's envelope, with its wait. */
    private static function assertThrottled(TestResponse $response): void
    {
        $response->assertStatus(429)->assertJsonPath('error.status', 429)->assertJsonPath('data', null);
        self::assertNotNull($response->headers->get('Retry-After'));
    }

    public function test_a_password_sign_in_through_the_provider_callback_route_is_throttled(): void
    {
        for ($i = 0; $i < self::limit(); $i++) {
            $this->json('GET', '/api/auth/local/callback', ['identifier' => 'nobody', 'password' => 'wrong'])
                ->assertStatus(400);
        }

        self::assertThrottled($this->json('GET', '/api/auth/local/callback', ['identifier' => 'nobody', 'password' => 'wrong']));
    }
}
