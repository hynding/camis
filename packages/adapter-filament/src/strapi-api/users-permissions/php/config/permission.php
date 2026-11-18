<?php

declare(strict_types=1);

/*
 * Spatie's permission settings that camis sets: the role model keeps Strapi's millisecond
 * timestamps. Spatie merges its own defaults under every other key, as it does for a project that
 * publishes none.
 */
return [
    'models' => [
        'permission' => Spatie\Permission\Models\Permission::class,
        'role' => App\Models\StrapiRole::class,
    ],
];
