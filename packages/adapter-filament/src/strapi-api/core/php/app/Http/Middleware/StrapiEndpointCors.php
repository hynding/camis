<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use RuntimeException;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

/**
 * An IR endpoint that answers browsers on any origin itself (crossOrigin, public only): its
 * preflight allows the endpoint's method and exactly its declared request headers, and every answer,
 * the guards' refusals and the handler's errors included, allows any origin without credentials and
 * exposes Retry-After. No credential reaches a public endpoint, so a page on any origin can do no
 * more than any client can; that is also why credentials are never allowed.
 *
 * Laravel keeps only the last route of a method and path, so a path's one preflight route names
 * every such endpoint on it, and the preflight answers for the one whose method the browser asks.
 *
 * Laravel's HandleCors runs before routing, on every path config/cors.php lists, and would answer
 * this route's preflight with the app's settings and add its own headers to its answers. So
 * bootstrap/app.php skips it for a request this answers (answers()), and every other route keeps
 * the app's CORS unchanged. Settings come from config/camis-endpoints.php, by endpoint name; a route
 * naming an endpoint the config lacks (a config cache older than the routes) answers 500, never an
 * unguarded request.
 */
final class StrapiEndpointCors
{
    /** How long a browser may keep a preflight's answer, in seconds (Chromium keeps two hours at most). */
    private const MAX_AGE = '7200';

    public function handle(Request $request, Closure $next): Response
    {
        $named = self::named($request->route('endpoint'));
        if ($request->isMethod('OPTIONS')) {
            return self::openToAnyOrigin(self::preflight($named, $request->headers->get('Access-Control-Request-Method')));
        }
        foreach ($named as $endpoint) {
            self::guards($endpoint);
        }

        return self::openToAnyOrigin($next($request));
    }

    /**
     * Whether this answers the request, read before routing: the route it matches runs this, and a
     * preflight asks for the method of an endpoint on it. HandleCors answers every other request.
     * A route whose endpoint the config lacks is answered here, with 500.
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
        foreach (self::named($route->defaults['endpoint'] ?? null) as $endpoint) {
            $guards = config('camis-endpoints.'.$endpoint);
            if (! is_array($guards) || self::allows($guards, $asked)) {
                return true;
            }
        }

        return false;
    }

    /**
     * The asked method's endpoint's answer; with no method asked (an OPTIONS that is no preflight),
     * every endpoint's method on the path. The answer differs by what is asked, so a cache keeps one
     * per method and headers asked; never by origin, which every answer allows.
     *
     * @param list<string> $named
     */
    private static function preflight(array $named, ?string $asked): Response
    {
        $all = array_map(self::guards(...), $named);
        $chosen = array_values(array_filter($all, fn (array $guards): bool => $asked !== null && self::allows($guards, $asked)));
        $response = new Response('', 204, [
            'Access-Control-Allow-Methods' => implode(', ', array_map(
                fn (array $guards): string => (string) ($guards['method'] ?? ''),
                $chosen === [] ? $all : [$chosen[0]],
            )),
            'Access-Control-Max-Age' => self::MAX_AGE,
            'Vary' => 'Access-Control-Request-Method, Access-Control-Request-Headers',
        ]);
        $headers = $chosen === [] ? [] : array_map('strval', (array) ($chosen[0]['cross_origin_headers'] ?? []));
        if ($headers !== []) {
            $response->headers->set('Access-Control-Allow-Headers', implode(', ', $headers));
        }

        return $response;
    }

    /**
     * Whether a preflight asking for this method is for this endpoint; Laravel routes HEAD to a GET.
     *
     * @param array<mixed> $guards
     */
    private static function allows(array $guards, string $asked): bool
    {
        $method = (string) ($guards['method'] ?? '');
        $asked = strtoupper($asked);

        return $asked === $method || ($method === 'GET' && $asked === 'HEAD');
    }

    private static function openToAnyOrigin(Response $response): Response
    {
        $response->headers->set('Access-Control-Allow-Origin', '*');
        $response->headers->set('Access-Control-Expose-Headers', 'Retry-After');
        $response->headers->remove('Access-Control-Allow-Credentials');

        return $response;
    }

    /**
     * The endpoints a route names: its own, or on a preflight route every one on the path.
     *
     * @return list<string>
     */
    private static function named(mixed $endpoint): array
    {
        return array_values(array_map('strval', array_filter((array) $endpoint, 'is_string')));
    }

    /** @return array<mixed> */
    private static function guards(string $endpoint): array
    {
        $guards = config('camis-endpoints.'.$endpoint);
        if (! is_array($guards)) {
            throw new RuntimeException('config/camis-endpoints.php has no entry for endpoint "'.$endpoint.'"; clear a stale config cache (php artisan config:clear).');
        }

        return $guards;
    }
}
