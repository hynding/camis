<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Closure;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Symfony\Component\HttpFoundation\Response;

/**
 * Strapi's route auth: false. Its routes sit outside every credential middleware, and StrapiApiToken
 * passes them by, so no caller is authenticated; this answers every grant the request asks (the
 * route's own, a relation's, a list's row condition) as Strapi asks none. Route policies still run.
 */
final class StrapiPublicRoute
{
    private const ATTRIBUTE = 'camis.public_route';

    public function handle(Request $request, Closure $next): Response
    {
        $request->attributes->set(self::ATTRIBUTE, true);
        // Once per application: the callback reads whichever request is current.
        if (! app()->bound(self::ATTRIBUTE)) {
            app()->instance(self::ATTRIBUTE, true);
            Gate::before(static fn (?Authenticatable $user = null): ?bool => self::active() ? true : null);
        }

        return $next($request);
    }

    /** Whether the request's route is one this opens, read off the route before it runs. */
    public static function opens(Request $request): bool
    {
        return in_array(self::class, $request->route()?->middleware() ?? [], true);
    }

    /** Whether the current request runs a route this opened. */
    public static function active(): bool
    {
        return request()->attributes->get(self::ATTRIBUTE) === true;
    }
}
