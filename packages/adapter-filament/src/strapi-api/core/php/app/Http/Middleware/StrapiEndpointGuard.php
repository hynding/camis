<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Support\StrapiError;
use Closure;
use Illuminate\Http\Exceptions\ThrottleRequestsException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use RuntimeException;
use Symfony\Component\HttpFoundation\Response;

/**
 * An IR endpoint's declared guards (config/camis-endpoints.php, by the route's endpoint name), in
 * this order, before its handler runs: the throttle, the body's media type, the body's size. Each
 * refusal is thrown, so StrapiErrors answers it in Strapi's error shape. A route naming an endpoint
 * the config lacks (a config cache older than the routes) answers 500 rather than check nothing.
 *
 * The throttle counts every request that reaches it, refused ones included, per client address: an
 * IPv6 caller by its /64, the block one subscriber is given, so a caller cannot take a fresh address
 * per request. The cache key holds only an HMAC of the address under APP_KEY, which no list of
 * addresses reverses without the key; with no APP_KEY the throttle answers 500 rather than key it
 * with nothing. The count hit() returns decides, so parallel requests cannot
 * all pass one check. Behind a proxy Laravel does not trust every client shares the proxy's address
 * (DEPLOY.md says how to trust it).
 *
 * The body's size is checked against the declared Content-Length and against the bytes actually
 * read, up to one past the limit, since the header is the client's to state. Laravel decodes a JSON
 * body as it captures the request, before any middleware, so for JSON the limit refuses the request
 * before the handler, not before the decoding; PHP's post_max_size bounds that.
 */
final class StrapiEndpointGuard
{
    public function handle(Request $request, Closure $next): Response
    {
        // camis.endpoint: a dot no path parameter's name has, so none can replace it.
        $endpoint = (string) $request->route('camis.endpoint');
        $guards = config('camis-endpoints.'.$endpoint);
        if (! is_array($guards)) {
            throw new RuntimeException('config/camis-endpoints.php has no entry for endpoint "'.$endpoint.'"; clear a stale config cache (php artisan config:clear).');
        }

        if (isset($guards['throttle_per_minute'])) {
            self::throttle($request, $endpoint, max(1, (int) $guards['throttle_per_minute']));
        }
        if (isset($guards['accepts'])) {
            self::accepts($request, array_map('strval', (array) $guards['accepts']));
        }
        if (isset($guards['max_body_bytes'])) {
            self::size($request, max(1, (int) $guards['max_body_bytes']));
        }

        return $next($request);
    }

    private static function throttle(Request $request, string $endpoint, int $perMinute): void
    {
        $secret = (string) config('app.key');
        if ($secret === '') {
            throw new RuntimeException('APP_KEY is empty, and the endpoint throttle keys its counter with it; set it (php artisan key:generate).');
        }
        $caller = hash_hmac('sha256', self::caller((string) $request->ip()), $secret);
        $key = 'camis-endpoint|'.$endpoint.'|'.substr($caller, 0, 32);
        if (RateLimiter::hit($key, 60) > $perMinute) {
            throw new ThrottleRequestsException('Too Many Attempts.', null, [
                'Retry-After' => max(1, RateLimiter::availableIn($key)),
                'X-RateLimit-Limit' => $perMinute,
                'X-RateLimit-Remaining' => 0,
            ]);
        }
    }

    /** The caller an address counts as: an IPv6 address by its /64, an IPv4 one mapped into IPv6 as itself. */
    private static function caller(string $ip): string
    {
        $packed = filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false ? false : inet_pton($ip);
        if ($packed === false || strlen($packed) !== 16) {
            return $ip;
        }
        if (str_starts_with($packed, str_repeat("\0", 10)."\xff\xff")) {
            $address = inet_ntop(substr($packed, 12));

            return $address === false ? $ip : $address;
        }
        $block = inet_ntop(substr($packed, 0, 8).str_repeat("\0", 8));

        return $block === false ? $ip : $block.'/64';
    }

    /**
     * A body must name one of the media types, compared without parameters (charset and the like). A
     * request with no Content-Type must have no body. A form counts as a body even when PHP has
     * already parsed it and left nothing to read.
     *
     * @param list<string> $accepts
     */
    private static function accepts(Request $request, array $accepts): void
    {
        $header = $request->headers->get('Content-Type');
        if ($header === null || trim($header) === '') {
            if (self::read($request, 1) === '' && $request->request->count() === 0 && $request->files->count() === 0) {
                return;
            }
        } elseif (in_array(strtolower(trim(explode(';', $header, 2)[0])), $accepts, true)) {
            return;
        }

        throw new StrapiError(415, 'UnsupportedMediaTypeError', 'The request body must be '.implode(' or ', $accepts));
    }

    private static function size(Request $request, int $max): void
    {
        $declared = trim((string) $request->headers->get('Content-Length', ''));
        $tooLarge = (ctype_digit($declared) && (strlen(ltrim($declared, '0')) > 18 || (int) $declared > $max))
            || strlen(self::read($request, $max + 1)) > $max;
        if ($tooLarge) {
            throw new StrapiError(413, 'PayloadTooLargeError', 'Entity too large');
        }
    }

    /** At most $bytes of the raw body, read from its stream, so a large body is never read whole. */
    private static function read(Request $request, int $bytes): string
    {
        $stream = $request->getContent(true);
        $read = '';
        while (strlen($read) < $bytes && ! feof($stream)) {
            $chunk = fread($stream, max(1, min(8192, $bytes - strlen($read))));
            if ($chunk === false || $chunk === '') {
                break;
            }
            $read .= $chunk;
        }

        return $read;
    }
}
