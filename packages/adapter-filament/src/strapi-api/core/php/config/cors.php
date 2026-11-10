<?php

declare(strict_types=1);

/*
 * Laravel's HandleCors set up as Strapi's strapi::cors. Laravel's own defaults answer
 * `Access-Control-Allow-Origin: *` without credentials, and a browser drops every response to a
 * request made with `credentials: 'include'` (how a Strapi client keeps its httpOnly refresh
 * cookie) when the origin is `*`. Strapi allows credentials and echoes the request's origin;
 * HandleCors does the same once credentials are supported.
 *
 * The CAMIS_CORS_* keys are strapi::cors's options; `camis import strapi` writes them from the
 * Strapi project's config/middlewares. Each list is comma-separated.
 */

/** @return list<string> */
$list = static fn (string $name, string $default): array => array_values(array_filter(
    array_map('trim', explode(',', (string) env($name, $default))),
    static fn (string $item): bool => $item !== '',
));

return [
    // strapi::cors runs on every route, not only the API.
    'paths' => ['*'],

    'allowed_methods' => $list('CAMIS_CORS_METHODS', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS'),

    // `*` allows any origin, which is echoed back.
    'allowed_origins' => $list('CAMIS_CORS_ORIGIN', '*'),

    'allowed_origins_patterns' => [],

    // `*` allows whichever headers a preflight asks for, as Strapi does for an empty list.
    'allowed_headers' => $list('CAMIS_CORS_HEADERS', 'Content-Type,Authorization,Origin,Accept'),

    'exposed_headers' => $list('CAMIS_CORS_EXPOSE', ''),

    'max_age' => (int) env('CAMIS_CORS_MAX_AGE', 31536000),

    'supports_credentials' => (bool) env('CAMIS_CORS_CREDENTIALS', true),
];
