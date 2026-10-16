<?php

// @camis:generated — do not edit.

declare(strict_types=1);

return [
    // Requests per minute allowed on the unauthenticated credential endpoints
    // (POST /auth/local and /auth/local/register), keyed by client address.
    'auth_throttle_per_minute' => max(1, (int) env('CAMIS_AUTH_THROTTLE_PER_MINUTE', 10)),

    // Strapi's api.rest config, as a new Strapi project ships it: the page size when a request
    // names none, the largest one allowed (0 = no cap), and whether lists count their total.
    'rest' => [
        'default_limit' => (int) env('CAMIS_REST_DEFAULT_LIMIT', 25),
        'max_limit' => (int) env('CAMIS_REST_MAX_LIMIT', 100),
        'with_count' => (bool) env('CAMIS_REST_WITH_COUNT', true),
    ],
];
