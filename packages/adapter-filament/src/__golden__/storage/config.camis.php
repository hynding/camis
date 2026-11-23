<?php

// @camis:generated — do not edit.

declare(strict_types=1);

return [
    // Requests per minute allowed on each group of credential routes (sign-in, registration,
    // password recovery, ...), each group in a bucket of its own per client address, or per
    // account for a password change.
    'auth_throttle_per_minute' => max(1, (int) env('CAMIS_AUTH_THROTTLE_PER_MINUTE', 10)),

    // Shared with Strapi: the HS256 secret both apps sign and verify JWTs with.
    'jwt_secret' => (string) env('JWT_SECRET', ''),

    // Mirrors Strapi's own users-permissions "Enable email confirmation" advanced setting.
    'email_confirmation' => (bool) env('CAMIS_EMAIL_CONFIRMATION', false),
];
