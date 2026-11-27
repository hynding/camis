<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Hooks\Contracts\MemoIngestEndpoint;
use App\Hooks\Contracts\MemoTallyEndpoint;
use App\Hooks\MemoIngest;
use App\Hooks\MemoTally;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * An endpoint's declared guards (the author-role fixture's MemoIngest: public, 5 requests a minute,
 * 64 bytes, JSON or text, answering browsers on any origin with Content-Type and X-Memo-Key; and
 * MemoRestate, a PUT on the same path answering them with Content-Type and X-Memo-Version): one
 * preflight route answers each by the method asked, then MemoIngest's route refuses a caller over
 * the throttle, a body of another type and a body too large, each before the handler runs and each
 * answer carrying its CORS headers, while every other route keeps the app's CORS. A guarded route
 * whose config entry is missing refuses every request, and MemoTally's path parameter, named
 * endpoint, chooses neither its handler nor its guards. Needs bootstrap/app.php patched as camis
 * scaffold patches it. CI's author-role job copies this into tests/Feature.
 */
class EndpointGuardsTest extends TestCase
{
    private const ORIGIN = 'https://site.example';

    /** The bodies the handler was given, in order. */
    public static array $handled = [];

    protected function setUp(): void
    {
        parent::setUp();
        self::$handled = [];
        // The app's CORS (config/cors.php) allows credentials to the browser's origin, as a
        // deployment listing it in CAMIS_CORS_ORIGIN does: the endpoint must answer it otherwise.
        config(['cors.allowed_origins' => [self::ORIGIN], 'cors.supports_credentials' => true]);
        // The handler a project writes in place of the seeded one.
        $this->app->bind(MemoIngest::class, fn () => new class implements MemoIngestEndpoint {
            public function handle(Request $request): mixed
            {
                EndpointGuardsTest::$handled[] = $request->getContent();

                return ['data' => ['type' => $request->headers->get('Content-Type'), 'body' => $request->getContent()]];
            }
        });
    }

    /** A request as a browser on another origin sends it, with the server variables given. */
    private function fromBrowser(string $method, string $uri, array $server = [], ?string $body = null): TestResponse
    {
        return $this->call($method, $uri, [], [], [], ['HTTP_ORIGIN' => self::ORIGIN, ...$server], $body);
    }

    private function ingest(string $body, string $type = 'application/json', array $server = []): TestResponse
    {
        return $this->fromBrowser('POST', '/api/memos/ingest', ['CONTENT_TYPE' => $type, 'CONTENT_LENGTH' => (string) strlen($body), ...$server], $body);
    }

    /** Any origin may read it, never with credentials, and may read Retry-After. */
    private function assertOpenToAnyOrigin(TestResponse $response): void
    {
        $this->assertSame(['*'], $response->headers->all('access-control-allow-origin'));
        $this->assertFalse($response->headers->has('Access-Control-Allow-Credentials'));
        $this->assertSame('Retry-After', $response->headers->get('Access-Control-Expose-Headers'));
    }

    private function assertRefused(TestResponse $response, int $status, string $name): void
    {
        $response->assertStatus($status)->assertJsonPath('data', null)->assertJsonPath('error.status', $status)->assertJsonPath('error.name', $name);
        $this->assertOpenToAnyOrigin($response);
    }

    public function test_the_preflight_allows_the_endpoint_s_method_and_exactly_its_request_headers(): void
    {
        $response = $this->fromBrowser('OPTIONS', '/api/memos/ingest', [
            'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'POST',
            'HTTP_ACCESS_CONTROL_REQUEST_HEADERS' => 'content-type,x-memo-key',
        ]);

        $response->assertNoContent();
        $this->assertSame(['*'], $response->headers->all('access-control-allow-origin'));
        $this->assertSame('POST', $response->headers->get('Access-Control-Allow-Methods'));
        $this->assertSame('Content-Type, X-Memo-Key', $response->headers->get('Access-Control-Allow-Headers'));
        $this->assertFalse($response->headers->has('Access-Control-Allow-Credentials'));
        // The answer differs by the method and headers asked, so a cache keeps one per request.
        $this->assertSame('Access-Control-Request-Method, Access-Control-Request-Headers', $response->headers->get('Vary'));
        $this->assertSame([], self::$handled);
    }

    public function test_the_preflight_answers_each_endpoint_on_the_path_by_the_method_asked(): void
    {
        $put = $this->fromBrowser('OPTIONS', '/api/memos/ingest', [
            'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'PUT',
            'HTTP_ACCESS_CONTROL_REQUEST_HEADERS' => 'content-type,x-memo-version',
        ]);

        $put->assertNoContent();
        $this->assertSame(['*'], $put->headers->all('access-control-allow-origin'));
        $this->assertSame('PUT', $put->headers->get('Access-Control-Allow-Methods'));
        $this->assertSame('Content-Type, X-Memo-Version', $put->headers->get('Access-Control-Allow-Headers'));
        $this->assertFalse($put->headers->has('Access-Control-Allow-Credentials'));

        $post = $this->fromBrowser('OPTIONS', '/api/memos/ingest', ['HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'POST']);
        $this->assertSame('POST', $post->headers->get('Access-Control-Allow-Methods'));
        $this->assertSame('Content-Type, X-Memo-Key', $post->headers->get('Access-Control-Allow-Headers'));

        // The PUT itself answers any origin without credentials, whatever its handler answers.
        $this->assertOpenToAnyOrigin($this->fromBrowser('PUT', '/api/memos/ingest', ['CONTENT_TYPE' => 'application/json'], '{}'));
    }

    public function test_a_json_body_and_a_text_body_reach_the_handler_with_their_cors_headers(): void
    {
        $json = $this->ingest('{"event":"view"}')->assertOk()->assertJsonPath('data.body', '{"event":"view"}');
        $this->assertOpenToAnyOrigin($json);
        // navigator.sendBeacon sends a string as text/plain;charset=UTF-8: parameters are not compared.
        $text = $this->ingest('{"event":"leave"}', 'text/plain;charset=UTF-8')->assertOk()
            ->assertJsonPath('data.body', '{"event":"leave"}')->assertJsonPath('data.type', 'text/plain;charset=UTF-8');
        $this->assertOpenToAnyOrigin($text);
        $this->assertSame(['{"event":"view"}', '{"event":"leave"}'], self::$handled);
    }

    public function test_a_caller_over_the_throttle_gets_429_with_retry_after_and_the_handler_does_not_run(): void
    {
        config(['camis-endpoints.MemoIngest.throttle_per_minute' => 2]);
        $this->ingest('{}')->assertOk();
        $this->ingest('{}')->assertOk();
        $refused = $this->ingest('{}');

        $this->assertRefused($refused, 429, 'RateLimitError');
        $this->assertGreaterThan(0, (int) $refused->headers->get('Retry-After'));
        $this->assertCount(2, self::$handled);
    }

    public function test_ipv6_callers_count_by_their_64_block_keyed_under_the_app_s_secret(): void
    {
        config(['camis-endpoints.MemoIngest.throttle_per_minute' => 2]);
        $this->ingest('{}', 'application/json', ['REMOTE_ADDR' => '2001:db8:0:1::1'])->assertOk();
        $this->ingest('{}', 'application/json', ['REMOTE_ADDR' => '2001:db8:0:1:ffff::2'])->assertOk();
        $this->assertRefused($this->ingest('{}', 'application/json', ['REMOTE_ADDR' => '2001:db8:0:1::3']), 429, 'RateLimitError');
        // Another /64, and an IPv4 caller, count apart.
        $this->ingest('{}', 'application/json', ['REMOTE_ADDR' => '2001:db8:0:2::1'])->assertOk();
        $this->ingest('{}', 'application/json', ['REMOTE_ADDR' => '198.51.100.4'])->assertOk();

        // The key holds no address, only its HMAC under APP_KEY.
        $block = substr(hash_hmac('sha256', '2001:db8:0:1::/64', (string) config('app.key')), 0, 32);
        $this->assertSame(3, RateLimiter::attempts('camis-endpoint|MemoIngest|'.$block));
        $this->assertSame(0, RateLimiter::attempts('camis-endpoint|MemoIngest|'.substr(hash('sha256', '2001:db8:0:1::1'), 0, 32)));
        // An IPv4 address an IPv6 socket reports, mapped, is the IPv4 caller.
        $this->ingest('{}', 'application/json', ['REMOTE_ADDR' => '::ffff:198.51.100.4'])->assertOk();
        $v4 = substr(hash_hmac('sha256', '198.51.100.4', (string) config('app.key')), 0, 32);
        $this->assertSame(2, RateLimiter::attempts('camis-endpoint|MemoIngest|'.$v4));
    }

    public function test_a_guarded_route_whose_config_entry_is_missing_answers_500_and_checks_nothing_through(): void
    {
        // A config cache from before the endpoint had guards.
        config(['camis-endpoints.MemoIngest' => null, 'camis-endpoints.MemoRestate' => null]);

        $ingest = $this->ingest('{}');
        $ingest->assertStatus(500)->assertJsonPath('data', null)->assertJsonPath('error.name', 'InternalServerError');
        $this->fromBrowser('PUT', '/api/memos/ingest', ['CONTENT_TYPE' => 'application/json'], '{}')->assertStatus(500);
        $this->fromBrowser('OPTIONS', '/api/memos/ingest', ['HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'POST'])->assertStatus(500);
        $this->assertSame([], self::$handled);
    }

    public function test_a_path_parameter_named_endpoint_chooses_neither_the_handler_nor_the_guards(): void
    {
        $this->app->bind(MemoTally::class, fn () => new class implements MemoTallyEndpoint {
            public function handle(Request $request): mixed
            {
                EndpointGuardsTest::$handled[] = 'tally:'.$request->route('endpoint');

                return ['data' => ['endpoint' => $request->route('endpoint')]];
            }
        });

        // Another endpoint's name in the path reaches MemoTally's handler, MemoPin's roles not asked.
        $this->getJson('/api/memos/MemoIngest/tally')->assertOk()->assertJsonPath('data.endpoint', 'MemoIngest');
        $this->getJson('/api/memos/MemoPin/tally')->assertOk()->assertJsonPath('data.endpoint', 'MemoPin');
        // Its own throttle, 2 a minute, whatever the path names.
        $this->getJson('/api/memos/MemoRestate/tally')->assertStatus(429)->assertJsonPath('error.name', 'RateLimitError');
        $this->assertSame(['tally:MemoIngest', 'tally:MemoPin'], self::$handled);
    }

    public function test_refused_requests_count_toward_the_throttle(): void
    {
        config(['camis-endpoints.MemoIngest.throttle_per_minute' => 2]);
        $this->ingest('<a/>', 'application/xml')->assertStatus(415);
        $this->ingest(str_repeat('x', 65))->assertStatus(413);

        $this->assertRefused($this->ingest('{}'), 429, 'RateLimitError');
        $this->assertSame([], self::$handled);
    }

    public function test_a_body_of_another_media_type_is_refused_with_415(): void
    {
        $this->assertRefused($this->ingest('a=1', 'application/x-www-form-urlencoded'), 415, 'UnsupportedMediaTypeError');
        $this->assertRefused($this->ingest('<a/>', 'application/xml'), 415, 'UnsupportedMediaTypeError');
        $this->assertSame([], self::$handled);
    }

    public function test_a_body_declared_larger_than_the_limit_is_refused_with_413(): void
    {
        $this->assertRefused($this->ingest('{}', 'application/json', ['CONTENT_LENGTH' => '100000']), 413, 'PayloadTooLargeError');
        $this->assertSame([], self::$handled);
    }

    public function test_a_body_larger_than_the_limit_is_refused_with_413_whatever_its_content_length_says(): void
    {
        $large = '"'.str_repeat('x', 70).'"';
        $this->assertRefused($this->ingest($large, 'text/plain', ['CONTENT_LENGTH' => '10']), 413, 'PayloadTooLargeError');
        $absent = $this->fromBrowser('POST', '/api/memos/ingest', ['CONTENT_TYPE' => 'text/plain'], $large);
        $this->assertRefused($absent, 413, 'PayloadTooLargeError');
        // A body of exactly the limit is taken.
        $this->ingest(str_repeat('x', 64), 'text/plain')->assertOk();
        $this->assertSame([str_repeat('x', 64)], self::$handled);
    }

    public function test_every_other_route_keeps_the_app_s_cors(): void
    {
        $count = $this->fromBrowser('GET', '/api/memos/count')->assertOk();
        $this->assertSame([self::ORIGIN], $count->headers->all('access-control-allow-origin'));
        $this->assertSame('true', $count->headers->get('Access-Control-Allow-Credentials'));

        $preflight = $this->fromBrowser('OPTIONS', '/api/memos', ['HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'POST']);
        $preflight->assertNoContent();
        $this->assertSame([self::ORIGIN], $preflight->headers->all('access-control-allow-origin'));
        $this->assertSame('true', $preflight->headers->get('Access-Control-Allow-Credentials'));

        // Another method's preflight on the endpoints' path is the app's to answer.
        $other = $this->fromBrowser('OPTIONS', '/api/memos/ingest', ['HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'DELETE']);
        $this->assertSame([self::ORIGIN], $other->headers->all('access-control-allow-origin'));
        $this->assertSame('true', $other->headers->get('Access-Control-Allow-Credentials'));

        // The endpoint itself still answers any origin without credentials.
        $this->assertOpenToAnyOrigin($this->ingest('{}')->assertOk());
    }
}
