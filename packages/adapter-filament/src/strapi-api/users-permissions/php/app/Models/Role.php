<?php

declare(strict_types=1);

namespace App\Models;

use App\Models\Concerns\HasMillisecondTimestamps;
use Spatie\Permission\Models\Role as SpatieRole;

/**
 * Spatie's role, keeping its timestamps to the millisecond as Strapi's up_roles does. The
 * generated config/permission.php makes it Spatie's role model, so every role read or written is one.
 */
class Role extends SpatieRole
{
    use HasMillisecondTimestamps;
}
