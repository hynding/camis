<?php

declare(strict_types=1);

// The admin's interface languages (Strapi's admin config.locales), as CAMIS_ADMIN_LOCALES=en,fr,
// and the path the admin panel is served at (Strapi's admin config.url), as CAMIS_ADMIN_PATH: an
// empty one, as an unset variable it names leaves it, keeps /admin.
return [
    'path' => trim((string) env('CAMIS_ADMIN_PATH'), '/') ?: 'admin',
    'locales' => array_values(array_filter(array_map('trim', explode(',', (string) env('CAMIS_ADMIN_LOCALES', 'en'))))),
];
