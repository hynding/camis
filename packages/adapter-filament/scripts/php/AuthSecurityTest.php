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

    /** @var list<string> */
    private array $env = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        foreach ($this->env as $name) {
            putenv($name);
            unset($_ENV[$name], $_SERVER[$name]);
        }
    }

    /** Boots the app again with $env set, for settings read when the config is loaded. */
    private function bootWith(array $env): void
    {
        foreach ($env as $name => $value) {
            putenv("{$name}={$value}");
            $_ENV[$name] = $_SERVER[$name] = $value;
            $this->env[] = $name;
        }
        $this->refreshApplication();
    }

    private function preflight(string $origin, string $headers = 'content-type'): TestResponse
    {
        return $this->call('OPTIONS', '/api/auth/refresh', server: [
            'HTTP_ORIGIN' => $origin,
            'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'POST',
            'HTTP_ACCESS_CONTROL_REQUEST_HEADERS' => $headers,
        ]);
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

    /** Credentials for `*` would let any site read what the visitor's refresh cookie buys. */
    public function test_any_origin_is_answered_without_credentials_by_default(): void
    {
        $response = $this->preflight('https://evil.example.test', 'x-strapi-refresh-cookie');

        $response->assertNoContent();
        self::assertSame('*', $response->headers->get('Access-Control-Allow-Origin'));
        self::assertNull($response->headers->get('Access-Control-Allow-Credentials'));
    }

    public function test_a_listed_origin_alone_is_answered_with_credentials(): void
    {
        $this->bootWith(['CAMIS_CORS_ORIGIN' => 'https://app.example.test']);

        $listed = $this->preflight('https://app.example.test', 'x-strapi-refresh-cookie,x-requested-with');
        self::assertSame('https://app.example.test', $listed->headers->get('Access-Control-Allow-Origin'));
        self::assertSame('true', $listed->headers->get('Access-Control-Allow-Credentials'));
        self::assertStringContainsStringIgnoringCase('x-strapi-refresh-cookie', (string) $listed->headers->get('Access-Control-Allow-Headers'));

        $other = $this->preflight('https://evil.example.test');
        self::assertNotSame('https://evil.example.test', $other->headers->get('Access-Control-Allow-Origin'));
    }

    public function test_a_cross_origin_client_can_read_retry_after(): void
    {
        $response = $this->call('GET', '/api/_health', server: ['HTTP_ORIGIN' => 'https://app.example.test']);

        self::assertSame('Retry-After', $response->headers->get('Access-Control-Expose-Headers'));
    }

    /** A session opened with its refresh token in the cookie, as a browser client asks. */
    private function cookieSession(): string
    {
        config(['camis.users_permissions.jwt_management' => 'refresh']);
        $this->register('alice');
        $login = $this->withHeader('x-strapi-refresh-cookie', 'httpOnly')
            ->postJson('/api/auth/local', ['identifier' => 'alice', 'password' => 'secret1'])->assertOk();
        $this->flushHeaders();

        return (string) $login->getCookie('strapi_up_refresh', false)?->getValue();
    }

    private function refreshWithCookie(string $cookie, array $headers = []): TestResponse
    {
        $this->app['auth']->forgetGuards();
        $this->flushHeaders();

        return $this->withUnencryptedCookie('strapi_up_refresh', $cookie)->withHeaders($headers)->postJson('/api/auth/refresh', []);
    }

    private static function assertRefused(TestResponse $response): void
    {
        $response->assertForbidden()->assertJsonPath('error.name', 'ForbiddenError')->assertJsonPath('data', null);
    }

    public function test_the_refresh_cookie_alone_is_refused(): void
    {
        self::assertRefused($this->refreshWithCookie($this->cookieSession()));
    }

    public function test_the_refresh_cookie_is_refused_from_another_origin_whatever_it_sends(): void
    {
        $cookie = $this->cookieSession();
        self::assertRefused($this->refreshWithCookie($cookie, ['Origin' => 'https://evil.example.test', 'X-Requested-With' => 'XMLHttpRequest']));
        self::assertRefused($this->refreshWithCookie($cookie, ['Origin' => 'null', 'x-strapi-refresh-cookie' => 'httpOnly']));
        // A CORS origin listed without credentials is no page of this app's.
        config(['cors.allowed_origins' => ['https://app.example.test'], 'cors.supports_credentials' => false]);
        self::assertRefused($this->refreshWithCookie($cookie, ['Origin' => 'https://app.example.test']));
    }

    public function test_the_refresh_cookie_is_taken_from_the_apps_own_origin(): void
    {
        $this->refreshWithCookie($this->cookieSession(), ['Origin' => 'http://localhost'])
            ->assertOk()->assertJsonStructure(['jwt']);
    }

    public function test_the_refresh_cookie_is_taken_from_a_cors_origin_allowed_credentials(): void
    {
        config(['cors.allowed_origins' => ['https://app.example.test'], 'cors.supports_credentials' => true]);
        $this->refreshWithCookie($this->cookieSession(), ['Origin' => 'https://app.example.test'])->assertOk();
    }

    public function test_the_refresh_cookie_is_taken_without_an_origin_with_a_header_that_needs_a_preflight(): void
    {
        $cookie = $this->cookieSession();
        // Without x-strapi-refresh-cookie the successor comes back in the body, as in Strapi.
        $rotated = $this->refreshWithCookie($cookie, ['X-Requested-With' => 'XMLHttpRequest'])->assertOk();
        $this->refreshWithCookie((string) $rotated->json('refreshToken'), ['x-strapi-refresh-cookie' => 'httpOnly'])
            ->assertOk()->assertCookie('strapi_up_refresh', encrypted: false);
    }

    /** No browser sends a body token on its own: a client that holds one is unaffected. */
    public function test_a_refresh_token_in_the_body_needs_no_origin(): void
    {
        config(['camis.users_permissions.jwt_management' => 'refresh']);
        $this->register('alice');
        $token = (string) $this->postJson('/api/auth/local', ['identifier' => 'alice', 'password' => 'secret1'])->json('refreshToken');

        $this->postJson('/api/auth/refresh', ['refreshToken' => $token])->assertOk()->assertJsonStructure(['jwt', 'refreshToken']);
    }

    public function test_refresh_is_throttled(): void
    {
        config(['camis.users_permissions.jwt_management' => 'refresh']);
        self::assertThrottled(fn (): TestResponse => $this->postJson('/api/auth/refresh', ['refreshToken' => 'nope.nope']), 401);
    }
}
