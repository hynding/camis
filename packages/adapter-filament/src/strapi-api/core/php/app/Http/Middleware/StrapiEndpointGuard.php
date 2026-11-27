<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Support\StrapiError;
use Closure;
use Illuminate\Http\Exceptions\ThrottleRequestsException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Symfony\Component\HttpFoundation\Response;

/**
 * An IR endpoint's declared guards (config/camis-endpoints.php, by the route's endpoint name), in
 * this order, before its handler runs: the throttle, the body's media type, the body's size. Each
 * refusal is thrown, so StrapiErrors answers it in Strapi's error shape.
 *
 * The throttle counts every request that reaches it, refused ones included, per client address. The
 * address is kept only inside the counter's key, and hashed there, so the cache holds no address.
 * The count hit() returns decides, so parallel requests cannot all pass one check. Behind an
 * untrusted proxy every client shares the proxy's address (DEPLOY.md says how to trust it).
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
        $endpoint = (string) $request->route('endpoint');
        $guards = (array) config('camis-endpoints.'.$endpoint, []);

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
        $key = 'camis-endpoint|'.$endpoint.'|'.substr(hash('sha256', (string) $request->ip()), 0, 32);
        if (RateLimiter::hit($key, 60) > $perMinute) {
            throw new ThrottleRequestsException('Too Many Attempts.', null, [
                'Retry-After' => max(1, RateLimiter::availableIn($key)),
                'X-RateLimit-Limit' => $perMinute,
                'X-RateLimit-Remaining' => 0,
            ]);
        }
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
