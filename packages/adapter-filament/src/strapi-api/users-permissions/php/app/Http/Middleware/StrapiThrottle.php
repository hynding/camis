<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Support\StrapiRateLimits;
use Closure;
use Illuminate\Http\Exceptions\ThrottleRequestsException;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * A credential route's turn of its group's bucket (StrapiRateLimits). Not Laravel's
 * ThrottleRequests, which the middleware priority sort would move ahead of StrapiCredentials:
 * listed after the route's credentials, this runs once the caller's account is known.
 */
final class StrapiThrottle
{
    public function handle(Request $request, Closure $next, string $group): Response
    {
        $wait = StrapiRateLimits::attempt($request, $group);
        if ($wait !== null) {
            throw new ThrottleRequestsException('Too Many Attempts.', null, [
                'Retry-After' => $wait,
                'X-RateLimit-Limit' => StrapiRateLimits::rate($group),
                'X-RateLimit-Remaining' => 0,
            ]);
        }

        return $next($request);
    }
}
