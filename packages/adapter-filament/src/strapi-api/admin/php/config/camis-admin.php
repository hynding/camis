<?php

declare(strict_types=1);

// The admin's interface languages (Strapi's admin config.locales), as CAMIS_ADMIN_LOCALES=en,fr.
return [
    'locales' => array_values(array_filter(array_map('trim', explode(',', (string) env('CAMIS_ADMIN_LOCALES', 'en'))))),
];
