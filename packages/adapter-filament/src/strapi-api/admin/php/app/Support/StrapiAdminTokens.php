<?php

declare(strict_types=1);

namespace App\Support;

use App\Models\AdminUser;
use App\Models\StrapiAdminToken;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Support\Facades\Crypt;
use InvalidArgumentException;

/**
 * Strapi 5's admin tokens: a key acting in the admin as the account that made it, holding only
 * the permissions it was given. Strapi clamps a token to its owner's permissions whenever a role
 * or account changes; checking the owner at each use gives the same answer without that sync.
 */
final class StrapiAdminTokens
{
    /** The lifespans the admin offers, in milliseconds as Strapi keeps them; none never expires. */
    public const LIFESPANS = [7 * 86400000, 30 * 86400000, 90 * 86400000];

    /** The role standing for Strapi's Super Admin, who manages every account's tokens. */
    private const SUPER_ADMIN = 'super-admin';

    /**
     * @param  array{name: string, description?: string|null, lifespan?: int|null, admin_permissions?: list<string>|null}  $attributes
     * @return array{token: StrapiAdminToken, accessKey: string}
     */
    public static function create(AdminUser $owner, array $attributes): array
    {
        $lifespan = $attributes['lifespan'] ?? null;
        if ($lifespan !== null && ! in_array($lifespan, self::LIFESPANS, true)) {
            throw new InvalidArgumentException('lifespan must be one of 7, 30 or 90 days, or none');
        }
        $key = self::newKey();
        $token = new StrapiAdminToken();
        $token->forceFill([
            'name' => $attributes['name'],
            'description' => $attributes['description'] ?? '',
            'admin_user_owner_id' => $owner->id,
            'admin_permissions' => self::clamp($owner, $attributes['admin_permissions'] ?? []),
            'lifespan' => $lifespan,
            'expires_at' => $lifespan === null ? null : now()->addMilliseconds($lifespan),
        ] + self::keyed($key))->save();

        return ['token' => $token, 'accessKey' => $key];
    }

    /** A new key for the token; the old one stops verifying at once. */
    public static function regenerate(StrapiAdminToken $token): string
    {
        $key = self::newKey();
        $token->forceFill(self::keyed($key))->save();

        return $key;
    }

    /** The token's key, for its owner to copy again; null once the app key it was encrypted with changed. */
    public static function reveal(StrapiAdminToken $token): ?string
    {
        try {
            return $token->encrypted_key === null ? null : Crypt::decryptString($token->encrypted_key);
        } catch (DecryptException) {
            return null;
        }
    }

    /**
     * The admin token a key is, and the account it acts as; null for an unknown, expired or
     * content API token, and for an owner who may no longer sign in.
     *
     * @return array{0: StrapiAdminToken, 1: AdminUser}|null
     */
    public static function authenticate(string $key): ?array
    {
        $token = StrapiAdminToken::query()->where('access_key', StrapiApiTokens::hash($key))->first();
        if ($token === null || ($token->expires_at !== null && $token->expires_at->isPast())) {
            return null;
        }
        $owner = $token->owner;
        if (! $owner instanceof AdminUser || ! $owner->is_active || $owner->blocked) {
            return null;
        }
        // Strapi records a use at most hourly, so a busy token is not a write per request.
        if ($token->last_used_at === null || $token->last_used_at->lte(now()->subHour())) {
            $token->forceFill(['last_used_at' => now()])->saveQuietly();
        }

        return [$token, $owner];
    }

    /** A permission the token was given and its owner still holds. */
    public static function allows(StrapiAdminToken $token, AdminUser $owner, string $permission): bool
    {
        return in_array($permission, $token->admin_permissions ?? [], true) && $owner->can($permission);
    }

    /**
     * The permissions of $permissions the owner holds, which is all a token of theirs may be given.
     *
     * @param  list<string>  $permissions
     * @return list<string>
     */
    public static function clamp(AdminUser $owner, array $permissions): array
    {
        return array_values(array_unique(array_filter(
            $permissions,
            fn (string $permission): bool => isset(StrapiAdminPermissions::PERMISSIONS[$permission]) && $owner->can($permission),
        )));
    }

    /**
     * What the Admin Tokens page offers an account: each section's permissions it holds.
     *
     * @return array<string, array<string, string>> section → permission → its action's label
     */
    public static function offered(AdminUser $owner): array
    {
        $offered = [];
        foreach (StrapiAdminPermissions::SECTIONS as $section => $permissions) {
            foreach ($permissions as $permission) {
                if ($owner->can($permission)) {
                    $offered[$section][$permission] = StrapiAdminPermissions::label($permission);
                }
            }
        }

        return $offered;
    }

    public static function isSuperAdmin(AdminUser $admin): bool
    {
        return $admin->roles->contains('name', self::SUPER_ADMIN);
    }

    /** Strapi's owner-or-super-admin rule for reading, changing and revoking a token. */
    public static function manages(AdminUser $admin, StrapiAdminToken $token): bool
    {
        return (int) $token->admin_user_owner_id === (int) $admin->id || self::isSuperAdmin($admin);
    }

    private static function newKey(): string
    {
        return bin2hex(random_bytes(128));
    }

    /** @return array{access_key: string, encrypted_key: string} */
    private static function keyed(string $key): array
    {
        return ['access_key' => StrapiApiTokens::hash($key), 'encrypted_key' => Crypt::encryptString($key)];
    }
}
