<?php

declare(strict_types=1);

namespace App\Auth;

use App\Support\StrapiHashes;
use Illuminate\Auth\EloquentUserProvider;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\Eloquent\Model;

/**
 * The admin guard's accounts, as Laravel's Eloquent provider finds them, with their passwords
 * checked as Strapi's POST /admin/login checks them (StrapiHashes::matches): one hash check whatever
 * the email finds, so the panel's sign-in tells no admin account apart by its time; a hash the
 * hasher cannot read fails as a wrong password rather than a 500; Strapi's bcryptjs hashes match;
 * and a matched password of another cost is stored again at the configured one.
 */
final class CamisAdminUserProvider extends EloquentUserProvider
{
    /** The session guard checks a password only for an account found: one for none is checked here. */
    public function retrieveByCredentials(#[\SensitiveParameter] array $credentials)
    {
        $user = parent::retrieveByCredentials($credentials);
        $password = $credentials['password'] ?? null;
        if ($user === null && is_string($password)) {
            StrapiHashes::matches($password, null, 'admin');
        }

        return $user;
    }

    public function validateCredentials(Authenticatable $user, #[\SensitiveParameter] array $credentials): bool
    {
        $password = $credentials['password'] ?? null;

        return is_string($password) && $user instanceof Model && StrapiHashes::matches($password, $user, 'admin');
    }

    /** StrapiHashes::matches has stored a matched password again where its cost needed it. */
    public function rehashPasswordIfRequired(Authenticatable $user, #[\SensitiveParameter] array $credentials, bool $force = false): void
    {
    }
}
