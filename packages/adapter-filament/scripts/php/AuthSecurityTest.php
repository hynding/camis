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
        config(['camis.auth_throttle_per_minute' => self::RATE, 'camis.users_permissions.sessions.refresh_throttle_per_minute' => self::REFRESH_RATE, 'camis.users_permissions.auth_address_throttle_per_minute' => self::ADDRESS_RATE, 'camis.users_permissions.hide_account_existence' => true]);
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
     * A JSON body with a fresh name in the query string each time: the turn is the name the
     * controller looked up, never another.
     *
     * @return callable(int): TestResponse
     */
    private function queryNamed(string $method, string $path, array $body, string $address = '127.0.0.1'): callable
    {
        return function (int $attempt) use ($method, $path, $body, $address): TestResponse {
            $this->freshRequest();

            return $this->call($method, $path.'?identifier=fresh'.$attempt.'&email=fresh'.$attempt.'%40example.test', [], [], [], ['CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json', 'REMOTE_ADDR' => $address], (string) json_encode($body));
        };
    }

    public function test_the_turn_is_the_name_the_controller_looks_up_whatever_the_query_string_says(): void
    {
        $this->register('alice');
        self::assertThrottled($this->queryNamed('POST', '/api/auth/local', ['identifier' => 'alice', 'password' => 'wrong']), 400);
        $this->freshRequest();
        // Another address, so the sign-in ceiling the first address has used is not in the way.
        self::assertThrottled($this->queryNamed('GET', '/api/auth/local/callback', ['identifier' => 'bob', 'password' => 'wrong'], '10.1.0.1'), 400);
        self::assertThrottled($this->queryNamed('POST', '/api/auth/forgot-password', ['email' => 'alice@example.test']), 200);
        self::assertThrottled($this->queryNamed('POST', '/api/auth/send-email-confirmation', ['email' => 'carol@example.test']), 200);
    }

    /** A body sent as $type, as a page of another site can send it with no CORS preflight. */
    private function postAs(string $path, string $type, string $body, ?string $jwt = null): TestResponse
    {
        $this->freshRequest();
        $server = ['CONTENT_TYPE' => $type, 'HTTP_ACCEPT' => 'application/json'] + ($jwt === null ? [] : ['HTTP_AUTHORIZATION' => 'Bearer '.$jwt]);

        return $this->call('POST', $path, [], [], [], $server, $body);
    }

    private static function assertUnsupported(TestResponse $response): void
    {
        $response->assertStatus(415)->assertJsonPath('data', null)->assertJsonPath('error.status', 415)
            ->assertJsonPath('error.name', 'UnsupportedMediaTypeError')
            ->assertJsonPath('error.message', 'The request body must be JSON (Content-Type: application/json)');
    }

    public function test_an_auth_write_with_a_body_that_is_not_json_is_refused_unread(): void
    {
        $jwt = $this->register('alice');
        $sent = (string) json_encode(['identifier' => 'alice', 'username' => 'mallory', 'email' => 'mallory@example.test', 'password' => 'secret1', 'currentPassword' => 'secret1', 'passwordConfirmation' => 'secret2', 'code' => 'x', 'refreshToken' => 'x']);
        $paths = ['/api/auth/local', '/api/auth/local/register', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/send-email-confirmation', '/api/auth/refresh'];
        foreach (['text/plain', 'text/plain; charset=utf-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', 'text/json'] as $type) {
            foreach ($paths as $path) {
                self::assertUnsupported($this->postAs($path, $type, $sent));
            }
            self::assertUnsupported($this->postAs('/api/auth/change-password', $type, $sent, $jwt));
            self::assertUnsupported($this->postAs('/api/auth/logout', $type, $sent, $jwt));
        }
        self::assertUnsupported($this->postAs('/api/auth/local/register', 'application/x-www-form-urlencoded', 'username=mallory&email=mallory%40example.test&password=secret1'));
        $this->assertDatabaseMissing('users', ['username' => 'mallory']);
        // Nothing read, so nothing counted: the sign-in bucket is still full.
        $this->login('alice')->assertOk();
    }

    /**
     * PHP parses a form or multipart body into its fields before the app runs, leaving the raw body
     * empty, as the test client leaves it when given parameters: still a form, still refused.
     */
    public function test_a_form_php_has_already_parsed_is_refused(): void
    {
        $fields = ['identifier' => 'alice', 'password' => 'secret1', 'username' => 'mallory', 'email' => 'mallory@example.test'];
        foreach (['multipart/form-data; boundary=x', 'application/x-www-form-urlencoded', ''] as $type) {
            $this->freshRequest();
            self::assertUnsupported($this->call('POST', '/api/auth/local', $fields, [], [], ['CONTENT_TYPE' => $type, 'HTTP_ACCEPT' => 'application/json']));
            $this->freshRequest();
            self::assertUnsupported($this->call('POST', '/api/auth/local/register', $fields, [], [], ['CONTENT_TYPE' => $type, 'HTTP_ACCEPT' => 'application/json']));
        }
        $this->freshRequest();
        self::assertUnsupported($this->call('POST', '/api/auth/local', [], [], ['file' => \Illuminate\Http\UploadedFile::fake()->create('a.txt', 1)], ['CONTENT_TYPE' => 'multipart/form-data; boundary=x', 'HTTP_ACCEPT' => 'application/json']));
        // A form type with nothing in it is still a form.
        self::assertUnsupported($this->postAs('/api/auth/local', 'application/x-www-form-urlencoded', ''));
        $this->assertDatabaseMissing('users', ['username' => 'mallory']);
    }

    /** Laravel's throttle sorts ahead of unlisted middleware: a refused body must still not take a turn. */
    public function test_a_body_refused_as_not_json_takes_no_turn_of_laravels_throttle(): void
    {
        \Illuminate\Support\Facades\Route::middleware(['api', \App\Http\Middleware\StrapiErrors::class])->group(function (): void {
            \Illuminate\Support\Facades\Route::post('/api/camis-test-order', fn () => response()->json(['ok' => true]))
                ->middleware([\App\Http\Middleware\StrapiJsonBody::class, 'throttle:1,1']);
        });
        app('router')->getRoutes()->refreshNameLookups();
        for ($i = 0; $i < 3; $i++) {
            self::assertUnsupported($this->postAs('/api/camis-test-order', 'text/plain', '{}'));
        }
        $this->postAs('/api/camis-test-order', 'application/json', '{}')->assertOk();
    }

    public function test_an_auth_write_takes_json_by_any_of_its_names_and_an_empty_body(): void
    {
        config(['camis.auth_throttle_per_minute' => 10, 'camis.users_permissions.auth_address_throttle_per_minute' => 10]);
        $this->register('alice');
        $login = (string) json_encode(['identifier' => 'alice', 'password' => 'secret1']);
        foreach (['application/json', 'application/json; charset=UTF-8', 'Application/JSON', 'application/vnd.api+json'] as $type) {
            $this->postAs('/api/auth/local', $type, $login)->assertOk();
        }
        // No body has no type to check: Strapi's own validation answers it.
        $this->postAs('/api/auth/local', '', '')->assertStatus(400)->assertJsonPath('error.name', 'ValidationError');
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
            // An address each, so no route's bucket fills before its request is checked.
            $this->withServerVariables(['REMOTE_ADDR' => "10.4.0.{$i}"]);
            $response = $request();
            self::assertSame(400, $response->status(), "request {$i}: ".$response->getContent());
            $response->assertJsonPath('error.name', 'ValidationError');
        }
    }

    /** A name longer than any account's is refused as a wrong one, before it is folded or looked up. */
    public function test_an_identifier_longer_than_any_accounts_name_is_refused_unread(): void
    {
        \Illuminate\Support\Facades\DB::enableQueryLog();
        $this->postJson('/api/auth/local', ['identifier' => str_repeat('é', 256), 'password' => 'wrong'])->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError')->assertJsonPath('error.message', 'Invalid identifier or password');

        $lookups = array_filter(\Illuminate\Support\Facades\DB::getQueryLog(), fn (array $q): bool => preg_match('/from ["`]?users["`]?/i', $q['query']) === 1);
        self::assertSame([], array_values($lookups));
        // No turn was taken: not even the address's ceiling counted it.
        self::assertSame(0, \Illuminate\Support\Facades\RateLimiter::attempts('camis-throttle|sign-in|ip:127.0.0.1'));
    }

    /** No account can be made with a name longer than login takes: it could never sign in. */
    public function test_a_name_longer_than_login_takes_is_refused_on_registration(): void
    {
        $long = str_repeat('a', 256);
        $this->postJson('/api/auth/local/register', ['username' => $long, 'email' => 'long@example.test', 'password' => 'secret1'])->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError')->assertJsonPath('error.message', 'username must be at most 255 characters');
        $this->freshRequest();
        $this->postJson('/api/auth/local/register', ['username' => 'long', 'email' => $long.'@example.test', 'password' => 'secret1'])->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError');
        $this->freshRequest();
        $this->postJson('/api/auth/local/register', ['username' => str_repeat('b', 255), 'email' => 'b@example.test', 'password' => 'secret1'])->assertOk();
    }

    /** A user made over the API gets exactly one role: an array of them is refused, never applied. */
    public function test_a_user_made_over_the_api_names_a_single_role(): void
    {
        $token = \App\Support\StrapiApiTokens::create(['name' => 'full', 'type' => 'full-access'])['accessKey'];
        $roles = \Spatie\Permission\Models\Role::query()->pluck('id')->all();
        $user = ['username' => 'made', 'email' => 'made@example.test', 'password' => 'secret1'];
        $this->withToken($token)->postJson('/api/users', $user + ['role' => $roles])->assertStatus(400)
            ->assertJsonPath('error.name', 'ValidationError');
        $this->withToken($token)->postJson('/api/users', $user + ['role' => [$roles[0]]])->assertStatus(400);
        $this->withToken($token)->postJson('/api/users', ['username' => str_repeat('m', 256), 'email' => 'm@example.test', 'password' => 'secret1', 'role' => $roles[0]])->assertStatus(400);
        self::assertFalse(\App\Models\User::query()->where('email', 'made@example.test')->exists());

        $this->withToken($token)->postJson('/api/users', $user + ['role' => $roles[0]])->assertCreated();
    }

    /** A user's role changes to one role id, as Strapi's update validates it, or not at all. */
    public function test_a_user_updated_over_the_api_names_a_single_role_id(): void
    {
        $token = \App\Support\StrapiApiTokens::create(['name' => 'full', 'type' => 'full-access'])['accessKey'];
        $roles = \Spatie\Permission\Models\Role::query()->pluck('id')->all();
        $made = $this->withToken($token)->postJson('/api/users', ['username' => 'made', 'email' => 'made@example.test', 'password' => 'secret1', 'role' => $roles[0]])->assertCreated();
        $path = '/api/users/'.$made->json('id');
        foreach (['true' => true, '-1' => -1, '1.5' => 1.5] as $printed => $role) {
            $this->withToken($token)->putJson($path, ['role' => $role])->assertStatus(400)
                ->assertJsonPath('error.name', 'ValidationError')
                ->assertJsonPath('error.message', 'role must be a `strapiID` type, but the final value was: `'.$printed.'`.');
        }
        $this->withToken($token)->putJson($path, ['role' => [$roles[1]]])->assertStatus(400)->assertJsonPath('error.name', 'ValidationError');
        self::assertSame([$roles[0]], \App\Models\User::query()->findOrFail($made->json('id'))->roles->pluck('id')->all());
        $this->withToken($token)->putJson($path, ['role' => $roles[1]])->assertOk();
        self::assertSame([$roles[1]], \App\Models\User::query()->findOrFail($made->json('id'))->roles->pluck('id')->all());
    }

    /** Spaces, width, accents and case are folded out of a name; a number is no name at all. */
    public function test_a_name_buys_no_fresh_bucket_by_its_type_case_width_or_accents(): void
    {
        $names = ['12345', ' 12345 ', '１２３４５'];
        self::assertThrottled(fn (int $attempt): TestResponse => $this->postJson('/api/auth/local', ['identifier' => $names[$attempt] ?? '12345 ', 'password' => 'wrong']), 400);
        $folded = ['nobody', 'NÖBODY', 'ｎｏｂｏｄｙ'];
        self::assertThrottled(function (int $attempt) use ($folded): TestResponse {
            $this->freshRequest();

            return $this->withServerVariables(['REMOTE_ADDR' => '10.2.0.1'])->postJson('/api/auth/local', ['identifier' => $folded[$attempt] ?? 'nóbody', 'password' => 'wrong']);
        }, 400);
    }

    /**
     * Strapi validates strictly: a number, boolean, null, array or object is no string, and is
     * refused with yup's printed value, never cast or answered with a server error.
     */
    public function test_a_name_that_is_not_a_string_is_a_validation_error(): void
    {
        $printed = [
            "`[\n  \"\\\"alice\\\"\"\n]`" => ['alice'],
            "`{\n  \"a\": \"\\\"b\\\"\"\n}`" => ['a' => 'b'],
            '`12345`' => 12345,
            '`true`' => true,
            '`null`' => null,
        ];
        foreach ($printed as $shown => $identifier) {
            $this->freshRequest();
            $this->postJson('/api/auth/local', ['identifier' => $identifier, 'password' => 'wrong'])->assertStatus(400)
                ->assertJsonPath('error.name', 'ValidationError')
                ->assertJsonPath('error.message', "identifier must be a `string` type, but the final value was: {$shown}.");
        }
        $this->freshRequest();
        $this->postJson('/api/auth/local', ['identifier' => 'alice', 'password' => 123456])->assertStatus(400)
            ->assertJsonPath('error.message', 'password must be a `string` type, but the final value was: `123456`.');
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

    public function test_every_answer_with_an_access_token_says_how_long_it_lasts_in_refresh_mode(): void
    {
        config(['camis.users_permissions.jwt_management' => 'refresh', 'camis.users_permissions.sessions.access_token_lifespan' => 900, 'camis.auth_throttle_per_minute' => 10]);
        $register = $this->postJson('/api/auth/local/register', ['username' => 'alice', 'email' => 'alice@example.test', 'password' => 'secret1'])->assertOk();
        self::assertSame(900, $register->json('expiresIn'));
        $login = $this->login('alice')->assertOk();
        self::assertSame(900, $login->json('expiresIn'));
        $this->freshRequest();
        $cookie = $this->withHeader('x-strapi-refresh-cookie', 'httpOnly')->postJson('/api/auth/local', ['identifier' => 'alice', 'password' => 'secret1'])->assertOk();
        self::assertSame(900, $cookie->json('expiresIn'));
        self::assertNull($cookie->json('refreshToken'));
        $this->freshRequest();
        $refresh = $this->postJson('/api/auth/refresh', ['refreshToken' => $login->json('refreshToken')])->assertOk();
        self::assertSame(900, $refresh->json('expiresIn'));
        $this->freshRequest();
        $change = $this->withToken((string) $refresh->json('jwt'))->postJson('/api/auth/change-password', ['currentPassword' => 'secret1', 'password' => 'secret2', 'passwordConfirmation' => 'secret2'])->assertOk();
        self::assertSame(900, $change->json('expiresIn'));
        // The token lasts what the answer says, no longer.
        $this->travel(899)->seconds();
        $this->freshRequest();
        $this->withToken((string) $change->json('jwt'))->getJson('/api/users/me')->assertOk();
        $this->travel(2)->seconds();
        $this->freshRequest();
        $this->withToken((string) $change->json('jwt'))->getJson('/api/users/me')->assertUnauthorized();
    }

    public function test_a_legacy_token_answer_is_strapis_own(): void
    {
        $this->register('alice');
        self::assertArrayNotHasKey('expiresIn', $this->login('alice')->assertOk()->json());
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

    // ---------------------------------------------------------------- account existence

    /** The messages the array mailer holds: who each went to, and its subject. */
    private static function mails(): array
    {
        return array_map(
            fn ($sent): array => [$sent->getEnvelope()->getRecipients()[0]->getAddress(), $sent->getOriginalMessage()->getSubject()],
            \Illuminate\Support\Facades\Mail::mailer('array')->getSymfonyTransport()->messages()->all(),
        );
    }

    private static function forgetMails(): void
    {
        \Illuminate\Support\Facades\Mail::mailer('array')->getSymfonyTransport()->flush();
    }

    /**
     * Counts the hasher's makes and checks from here on: a bcrypt hasher of the configured cost
     * that keeps a tally, installed as the default driver.
     *
     * @return \ArrayObject<string, int>
     */
    /** An account whose stored password hash is $hash, written as an import or another driver left it. */
    private function accountWithHash(string $username, string $hash): void
    {
        $this->register($username);
        \App\Models\User::query()->where('username', $username)->toBase()->update(['password' => $hash]);
    }

    /** What a sign-in answers, as a client sees it. */
    private function signInSeen(string $identifier, string $password): array
    {
        $this->freshRequest();
        $response = $this->postJson('/api/auth/local', ['identifier' => $identifier, 'password' => $password]);

        return [$response->status(), $response->json()];
    }

    public function test_an_account_with_strapis_bcryptjs_hash_signs_in(): void
    {
        config(['camis.auth_throttle_per_minute' => 10, 'camis.users_permissions.auth_address_throttle_per_minute' => 10]);
        // bcryptjs writes $2a$ and $2b$ for the hash PHP writes as $2y$.
        foreach (['2a', '2b'] as $variant) {
            $this->accountWithHash("js{$variant}", '$'.$variant.substr(password_hash('secret1', PASSWORD_BCRYPT, ['cost' => 4]), 3));
            $this->login("js{$variant}")->assertOk();
            self::assertSame($this->signInSeen('nobody', 'secret1'), $this->signInSeen("js{$variant}", 'wrong'));
        }
    }

    public function test_a_stored_hash_the_hasher_cannot_verify_answers_as_no_account_does(): void
    {
        config(['camis.auth_throttle_per_minute' => 10, 'camis.users_permissions.auth_address_throttle_per_minute' => 10]);
        $this->accountWithHash('plain', 'secret1');
        $this->accountWithHash('argon', password_hash('secret1', PASSWORD_ARGON2ID));
        $unknown = $this->signInSeen('nobody', 'secret1');
        self::assertSame(400, $unknown[0]);
        self::assertSame($unknown, $this->signInSeen('plain', 'secret1'));
        self::assertSame($unknown, $this->signInSeen('argon', 'secret1'));
        // Each takes one hash check, as an unknown name does: the stand-in's.
        $tally = $this->countHashing();
        foreach (['plain', 'argon', 'nobody'] as $name) {
            $tally['check'] = 0;
            $this->signInSeen($name, 'secret1');
            self::assertSame(1, $tally['check'], "a sign-in as {$name} checks one hash");
        }
        // A password change checks the current password the same way: refused, never a 500.
        $jwt = $this->register('changer');
        \App\Models\User::query()->where('username', 'changer')->toBase()->update(['password' => 'secret1']);
        $this->freshRequest();
        $this->withToken($jwt)->postJson('/api/auth/change-password', ['currentPassword' => 'secret1', 'password' => 'secret2', 'passwordConfirmation' => 'secret2'])
            ->assertStatus(400)->assertJsonPath('error.message', 'The provided current password is invalid');
    }

    /** HASH_DRIVER moved off the driver the accounts were hashed with: they fail as no account does. */
    public function test_accounts_of_another_hash_driver_answer_as_no_account_does(): void
    {
        $this->register('alice');
        config(['hashing.driver' => 'argon2id']);
        app('hash')->forgetDrivers();
        self::assertSame($this->signInSeen('nobody', 'secret1'), $this->signInSeen('alice', 'secret1'));
    }

    public function test_an_imported_account_keeps_a_hash_php_verifies(): void
    {
        $this->accountWithHash('imported', '$2a'.substr(password_hash('secret1', PASSWORD_BCRYPT, ['cost' => 4]), 3));
        $archive = \App\Support\StrapiExport::write(sys_get_temp_dir().'/camis-hash-'.bin2hex(random_bytes(4)), \App\Support\StrapiExport::STAGES, true, null)['path'];
        \App\Support\StrapiImport::open($archive, null)->run(\App\Support\StrapiImport::STAGES);
        unlink($archive);
        self::assertStringStartsWith('$2y$', (string) \App\Models\User::query()->where('username', 'imported')->value('password'));
    }

    private function countHashing(): \ArrayObject
    {
        $tally = new \ArrayObject(['make' => 0, 'check' => 0]);
        app('hash')->extend('counting', fn () => new class ((array) config('hashing.bcrypt'), $tally) extends \Illuminate\Hashing\BcryptHasher {
            public function __construct(array $options, private \ArrayObject $tally)
            {
                parent::__construct($options);
            }

            public function make(#[\SensitiveParameter] $value, array $options = []): string
            {
                $this->tally['make']++;

                return parent::make($value, $options);
            }

            /** Counted once it has hashed: a hash refused unread costs no time, and so counts none. */
            public function check(#[\SensitiveParameter] $value, $hashedValue, array $options = []): bool
            {
                $matches = parent::check($value, $hashedValue, $options);
                $this->tally['check']++;

                return $matches;
            }
        });
        config(['hashing.driver' => 'counting']);
        app('hash')->forgetDrivers();

        return $tally;
    }

    private function confirmationOn(): void
    {
        config(['camis.users_permissions.advanced.email_confirmation' => true, 'mail.from.address' => 'hello@example.test']);
    }

    /** A request's answer as a client sees it: status and body, with the address it echoes left out. */
    private static function seen(TestResponse $response): array
    {
        $body = $response->json();
        unset($body['email']);

        return [$response->status(), $body];
    }

    /**
     * With email confirmation on, registration answers a taken address or username exactly as a
     * new account, hashes the password on both paths, creates nothing for a taken one and tells
     * the address by mail instead.
     */
    public function test_registration_answers_a_taken_address_or_username_as_a_new_one(): void
    {
        $this->register('alice');
        $this->confirmationOn();
        self::forgetMails();
        $tally = $this->countHashing();
        $answers = [];
        foreach ([['carol', 'carol@example.test'], ['alice2', 'alice@example.test'], ['alice', 'dave@example.test']] as $i => [$username, $email]) {
            $this->freshRequest();
            $tally['make'] = 0;
            $answers[] = $response = $this->withServerVariables(['REMOTE_ADDR' => "10.5.0.{$i}"])
                ->postJson('/api/auth/local/register', ['username' => $username, 'email' => $email, 'password' => 'secret1']);
            self::assertSame(1, $tally['make'], "registration {$i} hashes the password once");
            $response->assertOk()->assertJsonPath('sent', true)->assertJsonPath('email', $email);
        }
        self::assertSame(self::seen($answers[0]), self::seen($answers[1]));
        self::assertSame(self::seen($answers[0]), self::seen($answers[2]));

        self::assertSame(['carol'], \App\Models\User::query()->where('username', '!=', 'alice')->pluck('username')->all());
        self::assertEqualsCanonicalizing(
            [['carol@example.test', 'Account confirmation'], ['alice@example.test', 'Account registration'], ['dave@example.test', 'Account registration']],
            self::mails(),
        );
    }

    /** The bodies of the mails sent so far, by recipient. */
    private static function mailBodies(): array
    {
        $bodies = [];
        foreach (\Illuminate\Support\Facades\Mail::mailer('array')->getSymfonyTransport()->messages()->all() as $sent) {
            $bodies[$sent->getEnvelope()->getRecipients()[0]->getAddress()] = (string) $sent->getOriginalMessage()->getHtmlBody();
        }

        return $bodies;
    }

    /**
     * A username is looked up as an email too (as Strapi looks it up), so a username naming another
     * address would tell its registrant, by the mail they get, whether that address has an
     * account: it is refused before any lookup, alike whether or not the address has one.
     */
    public function test_a_username_naming_another_address_is_refused_before_any_lookup(): void
    {
        $this->confirmationOn();
        $answers = [];
        foreach (['bob', 'alice'] as $i => $existing) {
            $this->register($existing === 'alice' ? 'alice' : 'bob');
            $this->freshRequest();
            $answers[] = $this->withServerVariables(['REMOTE_ADDR' => "10.8.0.{$i}"])
                ->postJson('/api/auth/local/register', ['username' => 'Alice@Example.test', 'email' => "mallory{$i}@example.test", 'password' => 'secret1']);
        }
        $answers[0]->assertStatus(400)->assertJsonPath('error.name', 'ValidationError')
            ->assertJsonPath('error.message', 'username must not be an email address other than the one registering');
        self::assertSame([$answers[0]->status(), $answers[0]->json()], [$answers[1]->status(), $answers[1]->json()]);
        self::assertSame(0, \App\Models\User::query()->where('email', 'like', 'mallory%')->count());
        // An address of one's own as a username is no other address.
        $this->freshRequest();
        $this->postJson('/api/auth/local/register', ['username' => 'Carol@Example.test', 'email' => 'carol@example.test', 'password' => 'secret1'])
            ->assertOk()->assertJsonPath('sent', true);
        // With the setting off Strapi takes such a username, as Strapi does.
        config(['camis.users_permissions.hide_account_existence' => false]);
        $this->freshRequest();
        $this->postJson('/api/auth/local/register', ['username' => 'alice@example.test', 'email' => 'mallory@example.test', 'password' => 'secret1'])
            ->assertStatus(400)->assertJsonPath('error.message', 'Email or Username are already taken');
    }

    /** A taken address and a taken username get the one notice, which says neither was taken. */
    public function test_the_registration_notice_does_not_say_which_name_was_taken(): void
    {
        $this->register('alice');
        $this->confirmationOn();
        self::forgetMails();
        foreach ([['alice2', 'alice@example.test'], ['alice', 'dave@example.test']] as $i => [$username, $email]) {
            $this->freshRequest();
            $this->withServerVariables(['REMOTE_ADDR' => "10.9.0.{$i}"])
                ->postJson('/api/auth/local/register', ['username' => $username, 'email' => $email, 'password' => 'secret1'])->assertOk();
        }
        $bodies = self::mailBodies();
        self::assertSame($bodies['alice@example.test'], $bodies['dave@example.test']);
        self::assertStringContainsString('different username', $bodies['dave@example.test']);
    }

    /** Without email confirmation a new account gets its tokens at once, so a taken one is said so, as in Strapi. */
    public function test_registration_without_confirmation_still_says_an_address_is_taken(): void
    {
        $this->register('alice');
        $this->freshRequest();
        $this->postJson('/api/auth/local/register', ['username' => 'alice2', 'email' => 'alice@example.test', 'password' => 'secret1'])
            ->assertStatus(400)->assertJsonPath('error.message', 'Email or Username are already taken');
    }

    /** Turned off, registration and the confirmation resend answer as Strapi does. */
    public function test_strapis_own_answers_return_with_the_setting_off(): void
    {
        $this->register('alice');
        config(['camis.users_permissions.hide_account_existence' => false]);
        $this->confirmationOn();
        $this->freshRequest();
        $this->postJson('/api/auth/local/register', ['username' => 'alice2', 'email' => 'alice@example.test', 'password' => 'secret1'])
            ->assertStatus(400)->assertJsonPath('error.message', 'Email or Username are already taken');
        $this->freshRequest();
        \App\Models\User::query()->where('username', 'alice')->update(['confirmed' => true]);
        $this->postJson('/api/auth/send-email-confirmation', ['email' => 'alice@example.test'])
            ->assertStatus(400)->assertJsonPath('error.message', 'Already confirmed');
    }

    /** Resending the confirmation answers alike for a confirmed, blocked, unconfirmed or unknown address. */
    public function test_the_confirmation_resend_answers_every_address_alike(): void
    {
        $this->confirmationOn();
        foreach (['confirmed', 'blocked', 'pending'] as $username) {
            \App\Models\User::forceCreate(['name' => $username, 'username' => $username, 'email' => "{$username}@example.test", 'password' => 'x', 'provider' => 'local', 'confirmed' => $username === 'confirmed', 'blocked' => $username === 'blocked']);
        }
        self::forgetMails();
        $answers = [];
        foreach (['confirmed', 'blocked', 'pending', 'nobody'] as $i => $username) {
            $this->freshRequest();
            $answers[] = $this->withServerVariables(['REMOTE_ADDR' => "10.6.0.{$i}"])
                ->postJson('/api/auth/send-email-confirmation', ['email' => strtoupper($username).'@example.test'])
                ->assertOk()->assertJsonPath('email', "{$username}@example.test")->assertJsonPath('sent', true);
        }
        foreach ($answers as $answer) {
            self::assertSame(self::seen($answers[0]), self::seen($answer));
        }
        self::assertSame([['pending@example.test', 'Account confirmation']], self::mails());
    }

    /** Sign-in checks one password hash whether or not the name finds an account that has one. */
    public function test_sign_in_checks_one_password_hash_whether_or_not_an_account_matches(): void
    {
        $this->register('alice');
        \App\Models\User::forceCreate(['name' => 'oauth', 'username' => 'oauth', 'email' => 'oauth@example.test', 'password' => '', 'provider' => 'local']);
        $tally = $this->countHashing();
        foreach (['alice', 'nobody', 'oauth'] as $i => $identifier) {
            $this->freshRequest();
            $tally['check'] = 0;
            $this->withServerVariables(['REMOTE_ADDR' => "10.7.0.{$i}"])->postJson('/api/auth/local', ['identifier' => $identifier, 'password' => 'wrong'])
                ->assertStatus(400)->assertJsonPath('error.message', 'Invalid identifier or password');
            self::assertSame(1, $tally['check'], "a sign-in as {$identifier} checks one hash");
        }
    }

    /**
     * At a production cost the answer for a name that finds no account takes as long as a wrong
     * password's: medians of several tries, within a factor that wall-clock noise does not reach.
     */
    public function test_a_sign_in_for_no_account_takes_as_long_as_a_wrong_password(): void
    {
        config(['hashing.bcrypt.rounds' => 11]);
        app('hash')->forgetDrivers();
        $this->register('alice');
        $median = function (string $identifier): float {
            $times = [];
            for ($i = 0; $i < 5; $i++) {
                $this->freshRequest();
                $started = hrtime(true);
                $this->withServerVariables(['REMOTE_ADDR' => '10.8.'.crc32($identifier) % 200 .'.'.$i])->postJson('/api/auth/local', ['identifier' => $identifier, 'password' => 'wrong'])->assertStatus(400);
                $times[] = hrtime(true) - $started;
            }
            sort($times);

            return (float) $times[2];
        };
        $median('nobody');
        $wrong = $median('alice');
        $unknown = $median('nobody');
        self::assertGreaterThan(0.5, $unknown / $wrong, "no account: {$unknown}ns, wrong password: {$wrong}ns");
        self::assertLessThan(2.0, $unknown / $wrong, "no account: {$unknown}ns, wrong password: {$wrong}ns");
    }

    /** An account's mail is sent once the answer is out, so the answer's time does not show it. */
    public function test_account_mail_is_sent_after_the_answer(): void
    {
        $this->register('alice');
        self::forgetMails();
        config(['mail.from.address' => 'hello@example.test']);
        $atAnswer = null;
        \Illuminate\Support\Facades\Event::listen(\Illuminate\Foundation\Http\Events\RequestHandled::class, function () use (&$atAnswer): void {
            $atAnswer = count(self::mails());
        });
        $this->freshRequest();
        $this->postJson('/api/auth/forgot-password', ['email' => 'alice@example.test'])->assertOk()->assertExactJson(['ok' => true]);

        self::assertSame(0, $atAnswer);
        self::assertSame([['alice@example.test', 'Reset password']], self::mails());
    }

    /** POSTs $body to $path from a fresh client address each time, so no request throttle is in the way. */
    private function fromAnywhere(string $path, array $body): TestResponse
    {
        static $client = 0;
        $client++;
        $this->freshRequest();

        return $this->withServerVariables(['REMOTE_ADDR' => '10.20.'.intdiv($client, 250).'.'.($client % 250)])->postJson($path, $body);
    }

    /**
     * Registration, the confirmation resend and recovery each mail an address someone else names,
     * so each kind of mail goes to one address at most CAMIS_ACCOUNT_MAIL_PER_HOUR times an hour,
     * whoever asks and from wherever; a mail skipped changes nothing in the answer.
     */
    public function test_each_kind_of_account_mail_goes_to_an_address_once_an_hour(): void
    {
        $this->register('alice');
        \App\Models\User::forceCreate(['name' => 'pending', 'username' => 'pending', 'email' => 'pending@example.test', 'password' => 'x', 'provider' => 'local', 'confirmed' => false, 'blocked' => false]);
        $this->confirmationOn();
        self::forgetMails();
        $requests = [
            ['/api/auth/local/register', ['username' => 'alice', 'email' => 'victim@example.test', 'password' => 'secret1']],
            ['/api/auth/local/register', ['username' => 'alice2', 'email' => 'alice@example.test', 'password' => 'secret1']],
            ['/api/auth/send-email-confirmation', ['email' => 'pending@example.test']],
            ['/api/auth/forgot-password', ['email' => 'alice@example.test']],
        ];
        foreach ($requests as [$path, $body]) {
            $first = $this->fromAnywhere($path, $body)->assertOk();
            for ($i = 0; $i < 4; $i++) {
                $again = $this->fromAnywhere($path, $body)->assertOk();
                self::assertSame([$first->status(), $first->json()], [$again->status(), $again->json()]);
            }
        }
        self::assertEqualsCanonicalizing(
            [['victim@example.test', 'Account registration'], ['alice@example.test', 'Account registration'], ['pending@example.test', 'Account confirmation'], ['alice@example.test', 'Reset password']],
            self::mails(),
        );
        self::assertSame(0, \App\Models\User::query()->where('email', 'victim@example.test')->count());

        $this->travel(61)->minutes();
        self::forgetMails();
        $this->fromAnywhere(...$requests[0])->assertOk();
        self::assertSame([['victim@example.test', 'Account registration']], self::mails());
    }

    public function test_the_hourly_mail_bound_is_a_setting(): void
    {
        $this->register('alice');
        config(['camis.users_permissions.account_mail_per_hour' => 3, 'mail.from.address' => 'hello@example.test']);
        self::forgetMails();
        for ($i = 0; $i < 5; $i++) {
            $this->fromAnywhere('/api/auth/forgot-password', ['email' => 'alice@example.test'])->assertOk();
        }
        self::assertCount(3, self::mails());
    }

    /**
     * As a concurrent registration leaves it: $username's account exists, but the check before the
     * insert does not see it (a model scope hides it until the returned callable is called), so the
     * insert is the first to find the name taken.
     *
     * @return callable(): void
     */
    private function loseTheNextRace(string $username): callable
    {
        \App\Models\User::withoutEvents(fn () => \App\Models\User::forceCreate(['name' => $username, 'username' => $username, 'email' => "{$username}@example.test", 'password' => 'x', 'provider' => 'local']));
        $hidden = new \ArrayObject(['on' => true]);
        \App\Models\User::addGlobalScope('camis-test-race', function ($query) use ($hidden, $username): void {
            if ($hidden['on']) {
                $query->where('username', '!=', $username)->where('email', '!=', "{$username}@example.test");
            }
        });

        return function () use ($hidden): void {
            $hidden['on'] = false;
        };
    }

    /** Two registrations for one new name at once answer as a taken name does, never 400 "Validation failed". */
    public function test_a_registration_that_loses_a_race_for_its_name_answers_as_a_taken_one(): void
    {
        $this->confirmationOn();
        self::forgetMails();
        $body = ['username' => 'carol', 'email' => 'carol@example.test', 'password' => 'secret1'];
        $settled = $this->loseTheNextRace('carol');
        $lost = $this->fromAnywhere('/api/auth/local/register', $body);
        $settled();
        $taken = $this->fromAnywhere('/api/auth/local/register', $body);
        $lost->assertOk()->assertJsonPath('sent', true);
        self::assertSame([$taken->status(), $taken->json()], [$lost->status(), $lost->json()]);
        self::assertSame([['carol@example.test', 'Account registration']], self::mails());

        config(['camis.users_permissions.hide_account_existence' => false]);
        $settled = $this->loseTheNextRace('dave');
        $this->fromAnywhere('/api/auth/local/register', ['username' => 'dave', 'email' => 'dave@example.test', 'password' => 'secret1'])
            ->assertStatus(400)->assertJsonPath('error.name', 'ApplicationError')->assertJsonPath('error.message', 'Email or Username are already taken');
        $settled();
    }

    /**
     * A hash of another cost (every Strapi import is bcryptjs cost 10) takes another time to check,
     * which tells the account apart: the first sign-in that matches stores it at the configured cost.
     */
    public function test_a_sign_in_stores_the_password_again_at_the_configured_cost(): void
    {
        config(['camis.auth_throttle_per_minute' => 10, 'camis.users_permissions.auth_address_throttle_per_minute' => 10]);
        $rounds = (int) config('hashing.bcrypt.rounds');
        $this->accountWithHash('imported', '$2a'.substr(password_hash('secret1', PASSWORD_BCRYPT, ['cost' => $rounds + 1]), 3));
        $stored = fn (): string => (string) \App\Models\User::query()->where('username', 'imported')->value('password');
        $before = $stored();
        $this->signInSeen('imported', 'wrong');
        self::assertSame($before, $stored(), 'a wrong password changes nothing');
        $this->login('imported')->assertOk();
        self::assertStringStartsWith(sprintf('$2y$%02d$', $rounds), $stored());
        $this->login('imported')->assertOk();
    }

    /** A GraphQL operation as a client from a fresh address sends it: status and body. */
    private function graphqlSeen(string $query): array
    {
        $response = $this->fromAnywhere('/graphql', ['query' => $query]);

        return [$response->status(), $response->json()];
    }

    /**
     * GraphQL's register answers a user, which a hidden registration cannot give: every address,
     * new or taken, gets one error a client can tell apart as "check your email", and nothing else.
     */
    public function test_graphql_registration_answers_every_address_with_check_your_email(): void
    {
        $this->register('alice');
        $this->confirmationOn();
        self::forgetMails();
        $register = fn (string $username, string $email): array => $this->graphqlSeen(sprintf('mutation { register(input: { username: "%s", email: "%s", password: "secret1" }) { jwt user { username } } }', $username, $email));
        $new = $register('carol', 'carol@example.test');
        self::assertSame(200, $new[0]);
        self::assertNull($new[1]['data'] ?? null);
        self::assertSame('STRAPI_CONFIRMATION_PENDING_ERROR', $new[1]['errors'][0]['extensions']['code']);
        self::assertSame('ConfirmationPendingError', $new[1]['errors'][0]['extensions']['error']['name']);
        self::assertSame('Check your email to finish registering', $new[1]['errors'][0]['message']);
        self::assertSame($new, $register('alice2', 'alice@example.test'));
        self::assertSame($new, $register('alice', 'dave@example.test'));
        self::assertTrue(\App\Models\User::query()->where('username', 'carol')->exists());
        self::assertEqualsCanonicalizing(
            [['carol@example.test', 'Account confirmation'], ['alice@example.test', 'Account registration'], ['dave@example.test', 'Account registration']],
            self::mails(),
        );
        // With the setting off GraphQL answers as Strapi's: the user, and no session to confirm first.
        config(['camis.users_permissions.hide_account_existence' => false]);
        $strapi = $register('erin', 'erin@example.test');
        self::assertSame(['jwt' => null, 'user' => ['username' => 'erin']], $strapi[1]['data']['register']);
    }

    /** GraphQL's login and forgotPassword run REST's controllers, and so its protections. */
    public function test_graphql_sign_in_and_recovery_tell_no_account_apart(): void
    {
        config(['camis.auth_throttle_per_minute' => 10, 'camis.users_permissions.auth_address_throttle_per_minute' => 10, 'mail.from.address' => 'hello@example.test']);
        $this->register('alice');
        $this->accountWithHash('imported', '$2a'.substr(password_hash('secret1', PASSWORD_BCRYPT, ['cost' => 4]), 3));
        $this->accountWithHash('plain', 'secret1');
        $login = fn (string $identifier, string $password): array => $this->graphqlSeen(sprintf('mutation { login(input: { identifier: "%s", password: "%s" }) { jwt } }', $identifier, $password));
        $unknown = $login('nobody', 'secret1');
        self::assertSame('Invalid identifier or password', $unknown[1]['errors'][0]['message']);
        self::assertSame($unknown, $login('alice', 'wrong'));
        self::assertSame($unknown, $login('plain', 'secret1'));
        self::assertIsString($login('imported', 'secret1')[1]['data']['login']['jwt']);

        self::forgetMails();
        $forgot = fn (string $email): array => $this->graphqlSeen(sprintf('mutation { forgotPassword(email: "%s") { ok } }', $email));
        self::assertSame($forgot('nobody@example.test'), $forgot('alice@example.test'));
        self::assertSame($forgot('nobody@example.test'), $forgot('alice@example.test'));
        self::assertSame([['alice@example.test', 'Reset password']], self::mails());
        // A confirmation that names no account is refused as REST refuses it.
        $confirm = $this->graphqlSeen('mutation { emailConfirmation(confirmation: "nope") { jwt } }');
        self::assertSame('Invalid token', $confirm[1]['errors'][0]['message']);
    }

    /** A mail skipped by the bound leaves the link already mailed working: no token is rotated. */
    public function test_a_skipped_mail_keeps_the_token_already_mailed(): void
    {
        $this->register('alice');
        \App\Models\User::forceCreate(['name' => 'pending', 'username' => 'pending', 'email' => 'pending@example.test', 'password' => 'x', 'provider' => 'local', 'confirmed' => false, 'blocked' => false]);
        $this->confirmationOn();
        config(['camis.users_permissions.account_mail_per_hour' => 1]);
        $token = fn (string $column, string $username): ?string => \App\Models\User::query()->where('username', $username)->value($column);
        foreach ([['/api/auth/forgot-password', 'alice', 'reset_password_token'], ['/api/auth/send-email-confirmation', 'pending', 'confirmation_token']] as [$path, $username, $column]) {
            $this->fromAnywhere($path, ['email' => "{$username}@example.test"])->assertOk();
            $mailed = $token($column, $username);
            self::assertNotNull($mailed);
            $this->fromAnywhere($path, ['email' => "{$username}@example.test"])->assertOk();
            self::assertSame($mailed, $token($column, $username), "{$path} skipped keeps its token");
        }
    }
}

