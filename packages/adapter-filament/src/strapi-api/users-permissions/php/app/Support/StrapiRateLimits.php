<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Http\Exceptions\ThrottleRequestsException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;

/**
 * The credential throttle, one bucket per group of routes (sign-in, register, recovery,
 * password-reset, confirmation, provider, refresh, password-change) so a flood of one never locks
 * out another. A sign-in, recovery mail or confirmation mail counts per client address and the
 * account it names, so a guesser at one account, or everyone behind one address, cannot lock
 * another account out; the address's turns across every name it tries meet a ceiling of their
 * own. A password change counts per account, so a stolen access token gets no more guesses from
 * more addresses. Every other group counts per address. No group may count per caller account but
 * the password change: GraphQL's sign-in, registration and recovery take a caller's session as
 * Strapi's do, and each account whose token a caller sent would buy its address a fresh bucket.
 * The REST routes (StrapiThrottle) and the GraphQL mutations take their turns here, so both count
 * the same ones. Rates are read per request, so a cached route file keeps no stale number.
 */
final class StrapiRateLimits
{
    /** Groups with a rate of their own; every other group uses the credential rate. */
    private const RATES = ['refresh' => 'camis.users_permissions.sessions.refresh_throttle_per_minute'];

    /** Groups counted per account: each needs a session, so its account is the caller. */
    private const PER_ACCOUNT = ['password-change'];

    /** Groups counted per address and the account they name, by the body key that names it. */
    private const IDENTIFIED = ['sign-in' => 'identifier', 'recovery' => 'email', 'confirmation' => 'email'];

    private const ADDRESS_RATE = 'camis.users_permissions.auth_address_throttle_per_minute';

    /**
     * Takes a turn of $group's bucket: null when allowed, else the seconds until the next one.
     * $identifier is the account the request names where its body is not the request's own (a
     * GraphQL mutation's arguments); a REST route's is read from the body.
     */
    public static function attempt(Request $request, string $group, mixed $identifier = null): ?int
    {
        $caller = 'camis-throttle|'.$group.'|'.self::caller($request, $group);
        if (! isset(self::IDENTIFIED[$group])) {
            return self::take($caller, self::rate($group));
        }
        $name = self::hashed($identifier ?? $request->input(self::IDENTIFIED[$group]));
        $named = self::take($caller.'|id:'.$name, self::rate($group));
        $ceiling = self::take($caller, max(self::rate($group), (int) config(self::ADDRESS_RATE, 50)));

        return $named === null && $ceiling === null ? null : max($named ?? 0, $ceiling ?? 0);
    }

    /** Counts a failed attempt, refused once its bucket is full; a success is never counted. */
    public static function refuseFailure(Request $request, string $group): void
    {
        $wait = self::attempt($request, $group);
        if ($wait !== null) {
            throw self::tooMany($group, $wait);
        }
    }

    public static function tooMany(string $group, int $wait): ThrottleRequestsException
    {
        return new ThrottleRequestsException('Too Many Attempts.', null, ['Retry-After' => $wait, 'X-RateLimit-Limit' => self::rate($group), 'X-RateLimit-Remaining' => 0]);
    }

    public static function rate(string $group): int
    {
        return max(1, (int) config(self::RATES[$group] ?? 'camis.auth_throttle_per_minute', 10));
    }

    /** The count hit() returns decides, so parallel requests cannot all pass one check. */
    private static function take(string $key, int $max): ?int
    {
        return RateLimiter::hit($key, 60) > $max ? max(1, RateLimiter::availableIn($key)) : null;
    }

    /** A fixed-length digest of the normalised name, so no body text becomes part of a key. */
    private static function hashed(mixed $identifier): string
    {
        $identifier = is_string($identifier) ? $identifier : '';

        return substr(hash('sha256', mb_strtolower(trim($identifier))), 0, 32);
    }

    private static function caller(Request $request, string $group): string
    {
        $user = in_array($group, self::PER_ACCOUNT, true) ? $request->user() : null;

        return $user === null ? 'ip:'.$request->ip() : 'user:'.$user->getAuthIdentifier();
    }
}
