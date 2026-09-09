<?php

// @camis:generated — do not edit.

declare(strict_types=1);

return [
    // Requests per minute allowed on the unauthenticated credential endpoints
    // (POST /auth/local and /auth/local/register), keyed by client address.
    'auth_throttle_per_minute' => max(1, (int) env('CAMIS_AUTH_THROTTLE_PER_MINUTE', 10)),
];
