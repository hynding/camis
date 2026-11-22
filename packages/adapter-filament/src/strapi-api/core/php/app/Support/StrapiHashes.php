<?php

declare(strict_types=1);

namespace App\Support;

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
     * Whether $password is that of $account's account $id, stored as $hash (null: no account, or
     * none with a password), after exactly one hash check of the configured cost whatever it is: a
     * missing or unverifiable hash is checked against a stand-in, so a wrong name takes as long as a
     * wrong password.
     */
    public static function matches(string $password, ?string $hash, string $account, int|string|null $id): bool
    {
        $matches = $hash === null ? null : self::verify($password, $hash, $account, $id);
        if ($matches === null) {
            Hash::check($password, self::standIn());
        }

        return $matches === true;
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
