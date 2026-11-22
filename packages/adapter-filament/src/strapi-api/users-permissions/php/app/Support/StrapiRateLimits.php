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
 * name it gives, so a guesser at one name, or everyone behind one address, cannot lock another
 * account out; the address's turns across every name it tries meet a ceiling of their
 * own. A password change counts per account, so a stolen access token gets no more guesses from
 * more addresses. Every other group counts per address. No group may count per caller account but
 * the password change: GraphQL's sign-in, registration and recovery take a caller's session as
 * Strapi's do, and each account whose token a caller sent would buy its address a fresh bucket.
 * A named group's turn is taken by its controller, with the very name it then looks the account
 * up by: nothing here reads a request's fields, so the turn and the lookup cannot disagree. The REST
 * routes and the GraphQL mutations take their turns here, so both count the same ones. Rates are
 * read per request, so a cached route file keeps no stale number.
 */
final class StrapiRateLimits
{
    /** Groups with a rate of their own; every other group uses the credential rate. */
    private const RATES = ['refresh' => 'camis.users_permissions.sessions.refresh_throttle_per_minute'];

    /** Groups counted per caller account, since each needs a session that names its caller. */
    private const PER_ACCOUNT = ['password-change'];

    /** Groups counted per address and the name they give, by refuseNamed alone. */
    private const NAMED = ['sign-in', 'recovery', 'confirmation'];

    private const ADDRESS_RATE = 'camis.users_permissions.auth_address_throttle_per_minute';

    /** Takes a turn of $group's bucket: null when allowed, else the seconds until the next one. */
    public static function attempt(Request $request, string $group): ?int
    {
        if (in_array($group, self::NAMED, true)) {
            throw new \LogicException("The {$group} throttle counts the name given, through refuseNamed()");
        }

        return self::take('camis-throttle|'.$group.'|'.self::caller($request, $group), self::rate($group));
    }

    /** Takes a turn of $group's bucket, refused with the wait once it is full. */
    public static function refuse(Request $request, string $group): void
    {
        $wait = self::attempt($request, $group);
        if ($wait !== null) {
            throw self::tooMany($group, $wait);
        }
    }

    /**
     * A named group's turn: $identifier is the name the account is about to be looked up by. One
     * bucket for the name, with the case, width and accents a database collation may ignore folded
     * out, and the address's ceiling across every name it tries. Nothing the lookup finds bears on
     * it: a bucket of the account's own would tell a caller which names are one account, or that
     * one exists. A name a collation matches that folding does not is bounded by the ceiling.
     */
    public static function refuseNamed(Request $request, string $group, string $identifier): void
    {
        $address = 'camis-throttle|'.$group.'|ip:'.$request->ip();
        $name = substr(hash('sha256', self::folded($identifier)), 0, 32);
        $waits = [
            self::take($address.'|id:'.$name, self::rate($group)),
            self::take($address, max(self::rate($group), (int) config(self::ADDRESS_RATE, 50))),
        ];
        $wait = max(array_map(fn (?int $w): int => $w ?? 0, $waits));
        if ($wait > 0) {
            throw self::tooMany($group, $wait);
        }
    }

    /**
     * Whether a mail of $kind may go to $address now, taking its turn: each kind of account mail
     * goes to an address the caller names, so it is bounded per recipient, whoever asks. Its turn is
     * taken where the mail is sent, after the answer when accounts are hidden, so a mail skipped
     * changes neither the answer nor its time.
     */
    public static function mailable(string $kind, string $address): bool
    {
        $key = 'camis-mail|'.$kind.'|'.substr(hash('sha256', self::folded($address)), 0, 32);

        return RateLimiter::hit($key, 3600) <= max(1, (int) config('camis.users_permissions.account_mail_per_hour', 3));
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

    /** The name without the case, width and accents a database collation may ignore. */
    private static function folded(string $identifier): string
    {
        $decomposed = \Normalizer::normalize(trim($identifier), \Normalizer::FORM_KD);

        return mb_convert_case((string) preg_replace('/\p{Mn}+/u', '', is_string($decomposed) ? $decomposed : $identifier), MB_CASE_FOLD);
    }

    private static function caller(Request $request, string $group): string
    {
        $user = in_array($group, self::PER_ACCOUNT, true) ? $request->user() : null;

        return $user === null ? 'ip:'.$request->ip() : 'user:'.$user->getAuthIdentifier();
    }
}
