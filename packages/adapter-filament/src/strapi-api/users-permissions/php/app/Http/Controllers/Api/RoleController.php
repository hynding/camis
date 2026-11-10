<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Support\StrapiError;

final class RoleController extends Controller
{
    public function __invoke(): never
    {
        throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
    }
}
