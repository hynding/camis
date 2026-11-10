<?php

declare(strict_types=1);

namespace App\Support;

use App\Models\AdminUser;
use Illuminate\Http\Request;

/**
 * Strapi's admin access tokens: an HS256 JWT naming the admin account, signed with the project's
 * ADMIN_JWT_SECRET (Strapi's admin.auth.secret; unset, the app key) and good for 30 minutes, as
 * Strapi's admin sessions issue one. The content API never takes one: it is the admin API's only.
 */
final class StrapiAdminAuth
{
    private const LIFESPAN = 1800;

    public static function issue(AdminUser $admin): string
    {
        $now = now()->getTimestamp();

        return self::sign(['userId' => (string) $admin->id, 'type' => 'access', 'iat' => $now, 'exp' => $now + self::LIFESPAN]);
    }

    /** The request's admin account, or why there is none, as Strapi's admin strategy says it. */
    public static function admin(Request $request): AdminUser
    {
        $token = $request->bearerToken();
        $claims = $token === null ? null : self::verify($token);
        $id = $claims['userId'] ?? null;
        $admin = is_string($id) && ctype_digit($id) ? AdminUser::query()->find((int) $id) : null;
        if (! $admin instanceof AdminUser || ! $admin->is_active || $admin->blocked) {
            throw new StrapiError(401, 'UnauthorizedError', 'Missing or invalid credentials');
        }

        return $admin;
    }

    /** @param array<string, int|string> $claims */
    private static function sign(array $claims): string
    {
        $unsigned = self::encode(['alg' => 'HS256', 'typ' => 'JWT']) . '.' . self::encode($claims);

        return $unsigned . '.' . self::base64(hash_hmac('sha256', $unsigned, self::secret(), true));
    }

    /** @return array<string, mixed>|null the claims of a token this app signed and that has not expired */
    private static function verify(string $token): ?array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            return null;
        }
        [$header, $payload, $signature] = $parts;
        $expected = self::base64(hash_hmac('sha256', "{$header}.{$payload}", self::secret(), true));
        if (! hash_equals($expected, $signature)) {
            return null;
        }
        $claims = json_decode(self::decode($payload), true);
        if (! is_array($claims) || ($claims['type'] ?? null) !== 'access' || ! is_int($claims['exp'] ?? null) || $claims['exp'] < now()->getTimestamp()) {
            return null;
        }

        return $claims;
    }

    private static function secret(): string
    {
        return (string) (config('camis.admin_auth.secret') ?: config('app.key'));
    }

    /** @param array<string, int|string> $value */
    private static function encode(array $value): string
    {
        return self::base64((string) json_encode($value));
    }

    private static function base64(string $bytes): string
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    private static function decode(string $part): string
    {
        return (string) base64_decode(strtr($part, '-_', '+/'), true);
    }
}
