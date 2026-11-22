<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;

/**
 * The credential throttle, one bucket per group of routes (sign-in, register, recovery,
 * confirmation, provider, refresh, password-change) so a flood of one never locks out another.
 * A caller is counted by its account once it is signed in, so a stolen access token gets no more
 * guesses from more addresses, and by its address otherwise. The REST routes (StrapiThrottle) and
 * the GraphQL mutations take their turns here, so both count the same ones. Rates are read per
 * request, so a cached route file keeps no stale number.
 */
final class StrapiRateLimits
{
    /** Groups with a rate of their own; every other group uses the credential rate. */
    private const RATES = ['refresh' => 'camis.users_permissions.sessions.refresh_throttle_per_minute'];

    /** Takes a turn of $group's bucket: null when allowed, else the seconds until the next one. */
    public static function attempt(Request $request, string $group): ?int
    {
        $key = 'camis-throttle|'.$group.'|'.self::caller($request);
        if (RateLimiter::tooManyAttempts($key, self::rate($group))) {
            return max(1, RateLimiter::availableIn($key));
        }
        RateLimiter::hit($key, 60);

        return null;
    }

    public static function rate(string $group): int
    {
        return max(1, (int) config(self::RATES[$group] ?? 'camis.auth_throttle_per_minute', 10));
    }

    private static function caller(Request $request): string
    {
        $user = $request->user();

        return $user === null ? 'ip:'.$request->ip() : 'user:'.$user->getAuthIdentifier();
    }
}
