<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Hooks\Contracts\MemoIngestEndpoint;
use App\Hooks\MemoIngest;
use Illuminate\Http\Request;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

/**
 * An endpoint's declared guards (the author-role fixture's MemoIngest: public, 5 requests a minute,
 * 64 bytes, JSON or text, answering browsers on any origin with Content-Type and X-Memo-Key): its
 * route answers the preflight, then refuses a caller over the throttle, a body of another type and
 * a body too large, each before the handler runs and each answer carrying its CORS headers, while
 * every other route keeps the app's CORS. Needs bootstrap/app.php patched as camis scaffold
 * patches it. CI's author-role job copies this into tests/Feature.
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
        $this->assertSame([], self::$handled);
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

        // Another method's preflight on the endpoint's path is the app's to answer.
        $other = $this->fromBrowser('OPTIONS', '/api/memos/ingest', ['HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'PUT']);
        $this->assertSame([self::ORIGIN], $other->headers->all('access-control-allow-origin'));
        $this->assertSame('true', $other->headers->get('Access-Control-Allow-Credentials'));

        // The endpoint itself still answers any origin without credentials.
        $this->assertOpenToAnyOrigin($this->ingest('{}')->assertOk());
    }
}
