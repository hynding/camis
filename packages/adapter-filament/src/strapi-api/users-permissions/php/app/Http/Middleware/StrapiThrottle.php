<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Support\StrapiRateLimits;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * A credential route's turn of its group's bucket (StrapiRateLimits). Not Laravel's
 * ThrottleRequests, which the middleware priority sort moves ahead of every unprioritised route
 * middleware: this one is not prioritised, so it runs where the route lists it. The password
 * change lists it after the session's credentials, since it counts per account; the guest routes
 * list it first, since they count per address and the account the body names, which need none.
 */
final class StrapiThrottle
{
    public function handle(Request $request, Closure $next, string $group): Response
    {
        $wait = StrapiRateLimits::attempt($request, $group);
        if ($wait !== null) {
            throw StrapiRateLimits::tooMany($group, $wait);
        }

        return $next($request);
    }
}
