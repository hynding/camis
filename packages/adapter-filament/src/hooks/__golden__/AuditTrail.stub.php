<?php

declare(strict_types=1);

namespace App\Hooks;

use App\Hooks\Contracts\AuditTrailMiddleware;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

// Ring 2 middleware — hand-written. camis seeds this once and never overwrites it.
final class AuditTrail implements AuditTrailMiddleware
{
    public function handle(Request $request, Closure $next): Response
    {
        // TODO: wrap the request (Article: create, update, delete).
        return $next($request);
    }
}
