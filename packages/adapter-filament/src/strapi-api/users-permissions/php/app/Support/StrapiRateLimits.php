<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;

/**
 * The credential throttle, one bucket per group of routes (sign-in, register, recovery,
 * confirmation, provider, refresh, password-change) so a flood of one never locks out another.
 * Every group counts per client address, except a password change, which counts per account, so a
 * stolen access token gets no more guesses from more addresses. No other group may count per
 * account: GraphQL's sign-in, registration and recovery take a caller's session as Strapi's do,
 * and each account whose token a caller sent would buy its address a fresh bucket. The REST
 * routes (StrapiThrottle) and the GraphQL mutations take their turns here, so both count the same
 * ones. Rates are read per request, so a cached route file keeps no stale number.
 */
final class StrapiRateLimits
{
    /** Groups with a rate of their own; every other group uses the credential rate. */
    private const RATES = ['refresh' => 'camis.users_permissions.sessions.refresh_throttle_per_minute'];

    /** Groups counted per account: each needs a session, so its account is the caller. */
    private const PER_ACCOUNT = ['password-change'];

    /** Takes a turn of $group's bucket: null when allowed, else the seconds until the next one. */
    public static function attempt(Request $request, string $group): ?int
    {
        $key = 'camis-throttle|'.$group.'|'.self::caller($request, $group);
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

    private static function caller(Request $request, string $group): string
    {
        $user = in_array($group, self::PER_ACCOUNT, true) ? $request->user() : null;

        return $user === null ? 'ip:'.$request->ip() : 'user:'.$user->getAuthIdentifier();
    }
}
