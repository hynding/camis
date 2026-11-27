<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

/**
 * An IR endpoint that answers browsers on any origin itself (crossOrigin, public only): its
 * preflight allows the endpoint's method and exactly its declared request headers, and every answer,
 * the guards' refusals and the handler's errors included, allows any origin without credentials and
 * exposes Retry-After. No credential reaches a public endpoint, so a page on any origin can do no
 * more than any client can; that is also why credentials are never allowed.
 *
 * Laravel's HandleCors runs before routing, on every path config/cors.php lists, and would answer
 * this route's preflight with the app's settings and add its own headers to its answers. So
 * bootstrap/app.php skips it for a request this answers (answers()), and every other route keeps
 * the app's CORS unchanged. Settings come from config/camis-endpoints.php, by endpoint name.
 */
final class StrapiEndpointCors
{
    /** How long a browser may keep a preflight's answer, in seconds (Chromium keeps two hours at most). */
    private const MAX_AGE = '7200';

    public function handle(Request $request, Closure $next): Response
    {
        $guards = self::guards($request->route('endpoint'));

        return self::openToAnyOrigin($request->isMethod('OPTIONS') ? self::preflight($guards) : $next($request));
    }

    /**
     * Whether this answers the request, read before routing: the route it matches runs this, and a
     * preflight asks for the endpoint's own method. HandleCors answers every other request.
     */
    public static function answers(Request $request): bool
    {
        try {
            $route = app('router')->getRoutes()->match($request);
        } catch (Throwable) {
            return false;
        }
        if (! in_array(self::class, $route->gatherMiddleware(), true)) {
            return false;
        }
        $asked = $request->headers->get('Access-Control-Request-Method');
        if (! $request->isMethod('OPTIONS') || $asked === null) {
            return true;
        }

        return strtoupper($asked) === (self::guards($route->defaults['endpoint'] ?? null)['method'] ?? null);
    }

    /** @param array<string, mixed> $guards */
    private static function preflight(array $guards): Response
    {
        $response = new Response('', 204, [
            'Access-Control-Allow-Methods' => (string) ($guards['method'] ?? ''),
            'Access-Control-Max-Age' => self::MAX_AGE,
        ]);
        $headers = array_map('strval', (array) ($guards['cross_origin_headers'] ?? []));
        if ($headers !== []) {
            $response->headers->set('Access-Control-Allow-Headers', implode(', ', $headers));
        }

        return $response;
    }

    private static function openToAnyOrigin(Response $response): Response
    {
        $response->headers->set('Access-Control-Allow-Origin', '*');
        $response->headers->set('Access-Control-Expose-Headers', 'Retry-After');
        $response->headers->remove('Access-Control-Allow-Credentials');

        return $response;
    }

    /** @return array<string, mixed> */
    private static function guards(mixed $endpoint): array
    {
        return is_string($endpoint) ? (array) config('camis-endpoints.'.$endpoint, []) : [];
    }
}
