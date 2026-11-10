<?php

// @camis:generated — do not edit.

declare(strict_types=1);

return [
    // strapi::cors runs on every route, not only the API.
    'paths' => ['*'],

    'allowed_methods' => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],

    // strapi::cors's `origin`: a comma-separated list, or * for any origin (echoed back).
    'allowed_origins' => array_map('trim', explode(',', (string) env('CAMIS_CORS_ORIGIN', '*'))),

    'allowed_origins_patterns' => [],

    'allowed_headers' => ['Content-Type', 'Authorization', 'Origin', 'Accept'],

    'exposed_headers' => [],

    'max_age' => 31536000,

    'supports_credentials' => true,
];
