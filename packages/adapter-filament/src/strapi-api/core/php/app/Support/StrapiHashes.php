<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;

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
     * Whether $password matches $hash, the stored hash of $account's account $id. A hash the
     * configured hasher refuses to verify (another driver's, after HASH_DRIVER changed, or not a
     * hash at all) is a password that does not match, never an exception: a sign-in must fail as a
     * wrong password does, not answer 500.
     */
    public static function check(string $password, string $hash, string $account, int|string|null $id): bool
    {
        return self::verify($password, $hash, $account, $id) ?? false;
    }

    /**
     * As check(), with null for a hash the hasher refused unread. The operator learns which account
     * from the log, once an hour per account, and nothing of its hash, password or names.
     */
    public static function verify(string $password, string $hash, string $account, int|string|null $id): ?bool
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
