<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Models\AdminUser;
use Closure;
use Filament\Facades\Filament;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * The admin speaks the signed-in admin's interface language (Strapi's preferedLanguage), when it is
 * one of the admin's locales; otherwise the app's.
 */
class AdminLocale
{
    public function handle(Request $request, Closure $next): Response
    {
        $admin = Filament::auth()->user();
        $language = $admin instanceof AdminUser ? $admin->getAttribute('prefered_language') : null;
        if (is_string($language) && in_array($language, self::locales(), true)) {
            app()->setLocale($language);
        }

        return $next($request);
    }

    /**
     * The languages an admin may pick: Strapi's admin config.locales, here CAMIS_ADMIN_LOCALES.
     *
     * @return list<string>
     */
    public static function locales(): array
    {
        $locales = config('camis-admin.locales', ['en']);

        return is_array($locales) ? array_values(array_filter($locales, 'is_string')) : ['en'];
    }
}
