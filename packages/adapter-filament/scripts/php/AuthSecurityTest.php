<?php

declare(strict_types=1);

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * Where camis is stricter than Strapi on its credential routes: every route that checks a
 * password or a refresh token is throttled, each group of them in a bucket of its own, a password
 * change per account, and a throttled answer keeps its Retry-After. The rates are read per
 * request, so the test sets low ones. CI copies this into the scaffolded app's tests/Feature.
 */
class AuthSecurityTest extends TestCase
{
    use RefreshDatabase;

    /** @var list<string> */
    private array $env = [];

    private const RATE = 3;

    private const REFRESH_RATE = 5;

    /** The ceiling on one address's turns, across every identifier it names. */
    private const ADDRESS_RATE = 6;

    protected function setUp(): void
    {
        parent::setUp();
        $this->seed(\Database\Seeders\RolePermissionSeeder::class);
        config(['camis.auth_throttle_per_minute' => self::RATE, 'camis.users_permissions.sessions.refresh_throttle_per_minute' => self::REFRESH_RATE, 'camis.users_permissions.auth_address_throttle_per_minute' => self::ADDRESS_RATE]);
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

    private function register(string $username): string
    {
        return (string) $this->postJson('/api/auth/local/register', ['username' => $username, 'email' => "{$username}@example.test", 'password' => 'secret1'])
            ->assertOk()->json('jwt');
    }

    /**
     * Repeats a request: each of the first $limit answers is $expected, the next one is throttled
     * in Strapi's envelope, with its wait.
     *
     * @param callable(int): TestResponse $request called with the attempt's number
     */
    private static function assertThrottled(callable $request, int $expected, int $limit = self::RATE): void
    {
        for ($i = 0; $i < $limit; $i++) {
            $request($i)->assertStatus($expected);
        }
        $response = $request($limit);
        $response->assertStatus(429)->assertJsonPath('error.status', 429)->assertJsonPath('data', null)
            ->assertJsonPath('error.name', 'RateLimitError')
            ->assertJsonPath('error.message', 'Too many requests, please try again later.');
        self::assertNotNull($response->headers->get('Retry-After'));
    }

    /** As a fresh request finds the app: StrapiCredentials switches the default guard. */
    private function freshRequest(): void
    {
        $this->app['auth']->shouldUse('web');
        $this->app['auth']->forgetGuards();
        $this->flushHeaders();
        $this->unencryptedCookies = [];
        $this->withCredentials = false;
    }

    private function login(string $username): TestResponse
    {
        $this->freshRequest();

        return $this->postJson('/api/auth/local', ['identifier' => $username, 'password' => 'secret1']);
    }

    public function test_a_password_sign_in_through_the_provider_callback_route_is_throttled(): void
    {
        self::assertThrottled(fn (): TestResponse => $this->json('GET', '/api/auth/local/callback', ['identifier' => 'nobody', 'password' => 'wrong']), 400);
    }

    /** A stolen access token must not buy unlimited guesses, from however many addresses. */
    public function test_a_password_change_is_throttled_per_account_whatever_the_address(): void
    {
        $jwt = $this->register('alice');
        $guess = ['currentPassword' => 'wrong', 'password' => 'secret2', 'passwordConfirmation' => 'secret2'];
        self::assertThrottled(function (int $attempt) use ($jwt, $guess): TestResponse {
            $this->freshRequest();

            return $this->withServerVariables(['REMOTE_ADDR' => "10.0.0.{$attempt}"])
                ->withToken($jwt)->postJson('/api/auth/change-password', $guess);
        }, 400);

        // Another account's turns are its own.
        $this->freshRequest();
        $other = $this->register('bob');
        $this->freshRequest();
        $this->withToken($other)->postJson('/api/auth/change-password', $guess)->assertStatus(400);
    }

    /** Several tabs refreshing on load, or an office behind one address, must not lock out sign-in. */
    public function test_refreshes_have_a_bucket_and_a_rate_of_their_own(): void
    {
        config(['camis.users_permissions.jwt_management' => 'refresh']);
        $this->register('alice');
        self::assertThrottled(fn (): TestResponse => $this->postJson('/api/auth/refresh', ['refreshToken' => 'nope.nope']), 401, self::REFRESH_RATE);

        $this->login('alice')->assertOk();
    }

    /** A guesser at one account, or everyone behind one address, must not lock another account out. */
    public function test_sign_in_counts_per_identifier_so_one_account_cannot_lock_out_another(): void
    {
        $this->register('alice');
        $this->freshRequest();
        $this->register('bob');
        self::assertThrottled(function (): TestResponse {
            $this->freshRequest();

            return $this->postJson('/api/auth/local', ['identifier' => 'alice', 'password' => 'wrong']);
        }, 400);
        // The identifier is normalised, so its case and spaces buy no fresh bucket.
        $this->freshRequest();
        $this->postJson('/api/auth/local', ['identifier' => ' ALICE ', 'password' => 'secret1'])->assertStatus(429);

        $this->login('bob')->assertOk();
    }

    /**
     * A body of another content type (which the controller still reads as JSON) with a fresh name
     * in the query string each time: the turn is the name the controller looked up, never another.
     *
     * @return callable(int): TestResponse
     */
    private function plainText(string $method, string $path, array $body, string $address = '127.0.0.1'): callable
    {
        return function (int $attempt) use ($method, $path, $body, $address): TestResponse {
            $this->freshRequest();

            return $this->call($method, $path.'?identifier=fresh'.$attempt.'&email=fresh'.$attempt.'%40example.test', [], [], [], ['CONTENT_TYPE' => 'text/plain', 'HTTP_ACCEPT' => 'application/json', 'REMOTE_ADDR' => $address], (string) json_encode($body));
        };
    }

    public function test_the_turn_is_the_name_the_controller_looks_up_whatever_the_query_string_says(): void
    {
        $this->register('alice');
        self::assertThrottled($this->plainText('POST', '/api/auth/local', ['identifier' => 'alice', 'password' => 'wrong']), 400);
        $this->freshRequest();
        // Another address, so the sign-in ceiling the first address has used is not in the way.
        self::assertThrottled($this->plainText('GET', '/api/auth/local/callback', ['identifier' => 'bob', 'password' => 'wrong'], '10.1.0.1'), 400);
        self::assertThrottled($this->plainText('POST', '/api/auth/forgot-password', ['email' => 'alice@example.test']), 200);
        self::assertThrottled($this->plainText('POST', '/api/auth/send-email-confirmation', ['email' => 'carol@example.test']), 200);
    }

    /**
     * Whether a name finds an account, or which names are one account, must not show in the
     * throttle: an account's username then its email answer as a missing name's pair does.
     *
     * @return list<array{int, bool}>
     */
    private function guesses(array $names, string $address): array
    {
        $answers = [];
        foreach ($names as $name) {
            $this->freshRequest();
            $response = $this->withServerVariables(['REMOTE_ADDR' => $address])->postJson('/api/auth/local', ['identifier' => $name, 'password' => 'wrong']);
            $answers[] = [$response->status(), $response->headers->has('Retry-After')];
        }

        return $answers;
    }

    public function test_an_accounts_names_answer_as_a_missing_names_do(): void
    {
        $this->register('alice');
        $existing = $this->guesses(['alice', 'alice', 'alice', 'alice@example.test', 'alice@example.test'], '10.3.0.1');
        $missing = $this->guesses(['zed', 'zed', 'zed', 'zed@example.test', 'zed@example.test'], '10.3.0.2');

        self::assertSame($missing, $existing);
        self::assertSame([400, false], $existing[3]);
    }

    /** Strapi's yup string() refuses an array: each auth field answers 400, never a server error. */
    public function test_an_array_in_any_auth_field_is_a_validation_error(): void
    {
        $secret = ['password' => 'secret1', 'passwordConfirmation' => 'secret1'];
        $jwt = $this->register('alice');
        $requests = [
            fn (): TestResponse => $this->postJson('/api/auth/local/register', ['username' => ['x'], 'email' => 'x@example.test', 'password' => 'secret1']),
            fn (): TestResponse => $this->postJson('/api/auth/local/register', ['username' => 'x', 'email' => ['x@example.test'], 'password' => 'secret1']),
            fn (): TestResponse => $this->postJson('/api/auth/local/register', ['username' => 'x', 'email' => 'x@example.test', 'password' => ['secret1']]),
            fn (): TestResponse => $this->postJson('/api/auth/reset-password', ['code' => ['x']] + $secret),
            fn (): TestResponse => $this->postJson('/api/auth/reset-password', ['code' => 'x', 'password' => ['a'], 'passwordConfirmation' => ['a']]),
            fn (): TestResponse => $this->getJson('/api/auth/email-confirmation?confirmation[]=x'),
            fn (): TestResponse => $this->postJson('/api/auth/local', ['identifier' => 'alice', 'password' => ['secret1']]),
            fn (): TestResponse => $this->withToken($jwt)->postJson('/api/auth/change-password', ['currentPassword' => ['secret1'], 'password' => 'secret2', 'passwordConfirmation' => 'secret2']),
            fn (): TestResponse => $this->withToken($jwt)->postJson('/api/auth/change-password', ['currentPassword' => 'secret1', 'password' => ['secret2'], 'passwordConfirmation' => ['secret2']]),
        ];
        foreach ($requests as $i => $request) {
            $this->freshRequest();
            $response = $request();
            self::assertSame(400, $response->status(), "request {$i}: ".$response->getContent());
            $response->assertJsonPath('error.name', 'ValidationError');
        }
    }

    /** A name longer than any account's is refused as a wrong one, before it is folded or looked up. */
    public function test_an_identifier_longer_than_any_accounts_name_is_refused_unread(): void
    {
        $this->postJson('/api/auth/local', ['identifier' => str_repeat('é', 256), 'password' => 'wrong'])->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError')->assertJsonPath('error.message', 'Invalid identifier or password');
    }

    /** A number is the string the lookup casts it to; accents, width and case are folded out of a name. */
    public function test_a_name_buys_no_fresh_bucket_by_its_type_case_width_or_accents(): void
    {
        $names = [12345, '12345', ' 12345 '];
        self::assertThrottled(fn (int $attempt): TestResponse => $this->postJson('/api/auth/local', ['identifier' => $names[$attempt] ?? '１２３４５', 'password' => 'wrong']), 400);
        $folded = ['nobody', 'NÖBODY', 'ｎｏｂｏｄｙ'];
        self::assertThrottled(function (int $attempt) use ($folded): TestResponse {
            $this->freshRequest();

            return $this->withServerVariables(['REMOTE_ADDR' => '10.2.0.1'])->postJson('/api/auth/local', ['identifier' => $folded[$attempt] ?? 'nóbody', 'password' => 'wrong']);
        }, 400);
    }

    /** Strapi's yup string() refuses an array or object: a ValidationError, never a server error. */
    public function test_a_name_that_is_neither_string_nor_number_is_a_validation_error(): void
    {
        $this->postJson('/api/auth/local', ['identifier' => ['alice'], 'password' => 'wrong'])->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError')
            ->assertJsonPath('error.message', "identifier must be a `string` type, but the final value was: `[\n  \"alice\"\n]`.");
        $this->postJson('/api/auth/forgot-password', ['email' => ['a' => 1]])->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError');
        $this->postJson('/api/auth/send-email-confirmation', ['email' => [1]])->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError');
    }

    /** Naming a new identifier each time buys a guesser no more than the address's ceiling. */
    public function test_an_address_naming_many_identifiers_meets_its_ceiling(): void
    {
        self::assertThrottled(fn (int $attempt): TestResponse => $this->login("guess{$attempt}"), 400, self::ADDRESS_RATE);
        self::assertThrottled(fn (int $attempt): TestResponse => $this->postJson('/api/auth/forgot-password', ['email' => "guess{$attempt}@example.test"]), 200, self::ADDRESS_RATE);

        // The ceiling is the address's: another address keeps its own.
        $this->freshRequest();
        $this->withServerVariables(['REMOTE_ADDR' => '10.0.0.9'])->postJson('/api/auth/local', ['identifier' => 'guess-new', 'password' => 'wrong'])->assertStatus(400);
    }

    public function test_one_group_of_credential_routes_cannot_use_up_another(): void
    {
        $this->register('alice');
        self::assertThrottled(fn (): TestResponse => $this->postJson('/api/auth/forgot-password', ['email' => 'nobody@example.test']), 200);
        self::assertThrottled(fn (): TestResponse => $this->login('nobody'), 400, self::RATE);
        // Neither recovery nor sign-in used up registration, nor the email confirmation.
        $this->freshRequest();
        $this->register('bob');
        $this->postJson('/api/auth/send-email-confirmation', ['email' => 'nobody@example.test'])->assertOk();
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

        return $this->withCredentials()->withUnencryptedCookie('strapi_up_refresh', $cookie)->withHeaders($headers)->postJson('/api/auth/refresh', []);
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

    /**
     * A foreign page's refreshes ride on the victim's cookie and address: they are failures, and
     * the bucket they fill refuses failures alone, never a refresh that rotates a valid token.
     */
    public function test_a_foreign_page_cannot_use_up_its_victims_refreshes(): void
    {
        $cookie = $this->cookieSession();
        for ($i = 0; $i < self::REFRESH_RATE; $i++) {
            self::assertRefused($this->refreshWithCookie($cookie, ['Origin' => 'https://evil.example.test']));
        }
        $this->refreshWithCookie($cookie, ['Origin' => 'https://evil.example.test'])->assertStatus(429)
            ->assertJsonPath('error.name', 'RateLimitError');
        $this->refreshWithCookie('nope.nope', ['x-strapi-refresh-cookie' => 'httpOnly'])->assertStatus(429);

        $this->refreshWithCookie($cookie, ['x-strapi-refresh-cookie' => 'httpOnly'])->assertOk()->assertJsonStructure(['jwt']);
    }

    public function test_the_refresh_cookie_is_taken_from_the_apps_own_origin(): void
    {
        $this->refreshWithCookie($this->cookieSession(), ['Origin' => rtrim((string) config('app.url'), '/')])
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

    private function cookieLogin(): \Symfony\Component\HttpFoundation\Cookie
    {
        config(['camis.users_permissions.jwt_management' => 'refresh']);
        $this->register('alice');
        $cookie = $this->withHeader('x-strapi-refresh-cookie', 'httpOnly')
            ->postJson('/api/auth/local', ['identifier' => 'alice', 'password' => 'secret1'])->assertOk()
            ->getCookie('strapi_up_refresh', false);
        self::assertNotNull($cookie);

        return $cookie;
    }

    public function test_the_refresh_cookie_is_http_only_strict_secure_and_sent_to_the_auth_routes_alone(): void
    {
        $cookie = $this->cookieLogin();

        self::assertTrue($cookie->isHttpOnly());
        self::assertTrue($cookie->isSecure());
        self::assertSame('strict', $cookie->getSameSite());
        self::assertSame('/api/auth', $cookie->getPath());
    }

    /** The browser drops the cookie when its session can no longer be refreshed, not before. */
    public function test_the_refresh_cookie_lasts_what_the_sessions_absolute_lifespan_has_left(): void
    {
        $lifespan = (int) config('camis.users_permissions.sessions.max_refresh_token_lifespan');
        $opened = time();
        $cookie = $this->cookieLogin();
        self::assertEqualsWithDelta($opened + $lifespan, $cookie->getExpiresTime(), 2);

        $this->travel(1)->days();
        $this->flushHeaders();
        $this->app['auth']->forgetGuards();
        $rotated = $this->withCredentials()->withUnencryptedCookie('strapi_up_refresh', (string) $cookie->getValue())
            ->withHeader('x-strapi-refresh-cookie', 'httpOnly')->postJson('/api/auth/refresh', [])->assertOk()
            ->getCookie('strapi_up_refresh', false);
        self::assertNotNull($rotated);
        self::assertEqualsWithDelta($cookie->getExpiresTime(), $rotated->getExpiresTime(), 2);
        // Max-Age is counted from the clock the browser reads, which travel() does not move.
        self::assertStringContainsString('max-age=', strtolower((string) $rotated));
    }

    public function test_the_refresh_cookie_goes_without_secure_only_when_asked_in_local_development(): void
    {
        config(['camis.users_permissions.sessions.cookie.secure' => false]);
        self::assertTrue($this->cookieLogin()->isSecure());

        $this->app['env'] = 'local';
        $this->flushHeaders();
        $cookie = $this->withHeader('x-strapi-refresh-cookie', 'httpOnly')
            ->postJson('/api/auth/local', ['identifier' => 'alice', 'password' => 'secret1'])->assertOk()
            ->getCookie('strapi_up_refresh', false);
        self::assertFalse($cookie?->isSecure());
    }

    /** Signs $username in with its refresh token in the cookie: the access token and the cookie. */
    private function cookieSignIn(string $username): array
    {
        $this->freshRequest();
        $login = $this->withHeader('x-strapi-refresh-cookie', 'httpOnly')
            ->postJson('/api/auth/local', ['identifier' => $username, 'password' => 'secret1'])->assertOk();

        return [(string) $login->json('jwt'), (string) $login->getCookie('strapi_up_refresh', false)?->getValue()];
    }

    private function logoutWith(string $jwt, string $cookie, array $body = []): TestResponse
    {
        $this->freshRequest();

        return $this->withCredentials()->withUnencryptedCookie('strapi_up_refresh', $cookie)
            ->withHeaders(['x-strapi-refresh-cookie' => 'httpOnly'])->withToken($jwt)->postJson('/api/auth/logout', $body)->assertOk();
    }

    private function refreshes(string $cookie): bool
    {
        $this->freshRequest();

        return $this->withCredentials()->withUnencryptedCookie('strapi_up_refresh', $cookie)
            ->withHeaders(['x-strapi-refresh-cookie' => 'httpOnly'])->postJson('/api/auth/refresh', [])->status() === 200;
    }

    /** A browser replaces a cookie only with one that matches it, SameSite=None and Secure included. */
    public function test_logout_clears_the_cookie_with_the_attributes_it_was_set_with(): void
    {
        config(['camis.users_permissions.jwt_management' => 'refresh', 'camis.users_permissions.sessions.cookie.same_site' => 'none', 'camis.users_permissions.sessions.cookie.domain' => 'api.example.test']);
        $this->register('alice');
        [$jwt, $cookie] = $this->cookieSignIn('alice');

        $cleared = $this->logoutWith($jwt, $cookie)->getCookie('strapi_up_refresh', false);
        self::assertNotNull($cleared);
        self::assertTrue($cleared->isCleared());
        self::assertSame('/api/auth', $cleared->getPath());
        self::assertSame('api.example.test', $cleared->getDomain());
        self::assertTrue($cleared->isSecure());
        self::assertTrue($cleared->isHttpOnly());
        self::assertSame('none', $cleared->getSameSite());
    }

    /** Without a known expiry the cookie lasts the browser session rather than none at all. */
    public function test_a_cookie_without_a_known_expiry_lasts_the_browser_session(): void
    {
        self::assertSame(0, \App\Support\StrapiSessions::cookie('session.secret', null)->getExpiresTime());
    }

    /** One browser, two tabs: the cookie is the newer sign-in's, and the older tab signs out. */
    public function test_logout_ends_its_own_session_and_keeps_another_sessions_cookie(): void
    {
        config(['camis.users_permissions.jwt_management' => 'refresh']);
        $this->register('alice');
        [$older, $olderCookie] = $this->cookieSignIn('alice');
        [$newer, $newerCookie] = $this->cookieSignIn('alice');

        $out = $this->logoutWith($older, $newerCookie);
        self::assertNull($out->getCookie('strapi_up_refresh', false));
        self::assertFalse($this->refreshes($olderCookie));
        self::assertTrue($this->refreshes($newerCookie));
    }

    public function test_logout_clears_the_cookie_of_the_session_it_ends_or_when_it_ends_all(): void
    {
        config(['camis.users_permissions.jwt_management' => 'refresh']);
        $this->register('alice');
        [$jwt, $cookie] = $this->cookieSignIn('alice');
        self::assertTrue($this->logoutWith($jwt, $cookie)->getCookie('strapi_up_refresh', false)?->isCleared());

        [$older] = $this->cookieSignIn('alice');
        [, $newerCookie] = $this->cookieSignIn('alice');
        self::assertTrue($this->logoutWith($older, $newerCookie, ['scope' => 'all'])->getCookie('strapi_up_refresh', false)?->isCleared());
        self::assertFalse($this->refreshes($newerCookie));
    }

    /**
     * An access token that names no session (a legacy token from before refresh mode) ends itself
     * on logout, not every session of its account, nor the session another tab's cookie names.
     */
    public function test_logout_with_a_token_that_names_no_session_ends_that_token_alone(): void
    {
        $legacy = $this->register('alice');
        config(['camis.users_permissions.jwt_management' => 'refresh']);
        $elsewhere = (string) $this->login('alice')->assertOk()->json('refreshToken');
        [, $cookie] = $this->cookieSignIn('alice');

        $out = $this->logoutWith($legacy, $cookie);

        self::assertNull($out->getCookie('strapi_up_refresh', false));
        self::assertTrue($this->refreshes($cookie));
        $this->freshRequest();
        $this->postJson('/api/auth/refresh', ['refreshToken' => $elsewhere])->assertOk();
        $this->freshRequest();
        self::assertContains($this->withToken($legacy)->getJson('/api/users/me')->status(), [401, 403]);
    }

    /** A session row swept at its absolute expiry leaves its access token in date, until logout. */
    public function test_logout_ends_the_access_token_when_its_session_row_is_gone(): void
    {
        config(['camis.users_permissions.jwt_management' => 'refresh']);
        $this->register('alice');
        $jwt = (string) $this->login('alice')->assertOk()->json('jwt');
        \Illuminate\Support\Facades\DB::table('strapi_sessions')->delete();

        $this->freshRequest();
        $this->withToken($jwt)->postJson('/api/auth/logout', [])->assertOk();
        $this->freshRequest();
        self::assertContains($this->withToken($jwt)->getJson('/api/users/me')->status(), [401, 403]);
    }

    /** The provider routes encrypt their own cookies; the refresh cookie must stay as refresh reads it. */
    public function test_a_refresh_cookie_from_the_provider_callback_route_refreshes(): void
    {
        config(['camis.users_permissions.jwt_management' => 'refresh']);
        $this->register('alice');
        $this->freshRequest();
        $cookie = $this->withHeader('x-strapi-refresh-cookie', 'httpOnly')
            ->json('GET', '/api/auth/local/callback', ['identifier' => 'alice', 'password' => 'secret1'])->assertOk()
            ->getCookie('strapi_up_refresh', false);

        self::assertNotNull($cookie);
        self::assertTrue($this->refreshes((string) $cookie->getValue()));
    }
}
