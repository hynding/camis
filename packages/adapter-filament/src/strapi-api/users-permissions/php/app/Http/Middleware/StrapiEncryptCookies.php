<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Illuminate\Cookie\Middleware\EncryptCookies;

/**
 * Laravel's cookie encryption for the provider routes' session, except the refresh cookie a
 * provider sign-in sets: /auth/refresh, outside this group, reads it as it was issued.
 */
final class StrapiEncryptCookies extends EncryptCookies
{
    public function isDisabled($name): bool
    {
        $refresh = config('camis.users_permissions.sessions.cookie.name');

        return $name === (is_string($refresh) && $refresh !== '' ? $refresh : 'strapi_up_refresh') || parent::isDisabled($name);
    }
}
