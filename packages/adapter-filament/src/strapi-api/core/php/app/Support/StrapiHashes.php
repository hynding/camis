<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/** Password hashes as Strapi writes them, read by the hasher this app is configured with. */
final class StrapiHashes
{
    /** bcryptjs writes `$2a$` (and `$2b$`), the same hash PHP verifies as `$2y$`. */
    public static function fromBcryptjs(mixed $hash): ?string
    {
        if (! is_string($hash) || $hash === '') {
            return null;
        }

        return preg_match('/^\$2[ab]\$/', $hash) === 1 ? '$2y$'.substr($hash, 4) : $hash;
    }

    /**
     * Whether $password is $owner's, the $account account (null: none matched the name), after
     * exactly one hash check of the configured cost whatever it is: no account, no password or an
     * unverifiable hash is checked against a stand-in, so a wrong name takes as long as a wrong
     * password. A hash of another cost (a Strapi import's bcryptjs 10) takes another time to check,
     * which tells the account apart: once the password is known it is stored at the configured one.
     */
    public static function matches(string $password, ?Model $owner, string $account): bool
    {
        $stored = $owner?->getAttribute('password');
        $matches = $owner !== null && is_string($stored) && $stored !== ''
            ? self::verify($password, $stored, $account, $owner->getKey())
            : null;
        if ($owner === null || ! is_string($stored) || $matches === null) {
            Hash::check($password, self::standIn());

            return false;
        }
        if ($matches && Hash::needsRehash((string) self::fromBcryptjs($stored))) {
            $owner->forceFill(['password' => Hash::make($password)])->save();
        }

        return $matches;
    }

    /** A hash of a random secret at the configured algorithm and cost, read on every check. */
    private static function standIn(): string
    {
        return Cache::rememberForever('camis-stand-in-hash:'.md5((string) json_encode(config('hashing'))), fn (): string => Hash::make(Str::random(40)));
    }

    /**
     * Whether $password matches $hash, or null for a hash the configured hasher refused unread
     * (another driver's, after HASH_DRIVER changed, or not a hash at all): a sign-in must then fail
     * as a wrong password does, not answer 500. The operator learns which account from the log,
     * once an hour per account, and nothing of its hash, password or names.
     */
    private static function verify(string $password, string $hash, string $account, int|string|null $id): ?bool
    {
        try {
            return Hash::check($password, self::fromBcryptjs($hash) ?? $hash);
        } catch (\RuntimeException) {
            if (Cache::add('camis-unverifiable-hash:'.$account.':'.$id, true, 3600)) {
                Log::warning('A stored password hash cannot be verified by the configured hasher', ['account' => $account, 'id' => $id]);
            }

            return null;
        }
    }
}
