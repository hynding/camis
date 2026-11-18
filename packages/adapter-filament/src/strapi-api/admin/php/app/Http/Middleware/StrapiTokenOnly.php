<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Support\StrapiApiTokens;
use App\Support\StrapiError;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * A plugin action no role Strapi ships holds (plugin::i18n.locales.listLocales): StrapiApiToken
 * has already let a token through only when it holds the action, so any other caller is refused.
 */
final class StrapiTokenOnly
{
    public function handle(Request $request, Closure $next): Response
    {
        if (! StrapiApiTokens::active()) {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }

        return $next($request);
    }
}
