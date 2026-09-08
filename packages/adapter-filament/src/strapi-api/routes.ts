import type { ContentType } from "@camis/ir-schema";
import { filamentNames } from "../names";
import { routePath } from "./names";

/** Requests per minute per IP allowed on the unauthenticated credential endpoints. */
const AUTH_THROTTLE = "throttle:10,1";

export const emitStrapiRoutes = (cts: ContentType[], secured: boolean): string => {
  const sorted = [...cts].sort((a, b) => routePath(a).localeCompare(routePath(b)));
  const uses = [
    "App\\Http\\Controllers\\Api\\AuthController",
    ...sorted.map((ct) => `App\\Http\\Controllers\\Api\\${filamentNames(ct).model}ApiController`),
    "App\\Http\\Middleware\\StrapiErrors",
    "Illuminate\\Support\\Facades\\Route",
  ]
    .sort()
    .map((u) => `use ${u};`)
    .join("\n");
  const resources = sorted
    .map((ct) => {
      const p = routePath(ct);
      const c = `${filamentNames(ct).model}ApiController::class`;
      return `        Route::get('/${p}', [${c}, 'index']);
        Route::post('/${p}', [${c}, 'store']);
        Route::get('/${p}/{key}', [${c}, 'show']);
        Route::put('/${p}/{key}', [${c}, 'update']);
        Route::delete('/${p}/{key}', [${c}, 'destroy']);`;
    })
    .join("\n\n");
  const guard = secured ? "Route::middleware('auth:sanctum')" : "Route::middleware([])";
  return `<?php

// @camis:generated — do not edit. Custom routes belong in routes/api-custom.php.

declare(strict_types=1);

${uses}

// Laravel's middleware priority sort moves Authenticate and ThrottleRequests ahead of any
// unprioritised route middleware, so applying StrapiErrors to the group below would leave it
// running last — an unauthenticated or throttled request would never reach it, and would return
// Laravel's default error body. Prepending it to the 'api' group makes it the first pipe for
// every route in the group; the resolved list is deduplicated, so it still runs exactly once.
Route::prependMiddlewareToGroup('api', StrapiErrors::class);

Route::middleware([StrapiErrors::class])->group(function (): void {
    Route::get('/_health', fn () => response()->noContent());
    // The only unauthenticated credential endpoints: throttled so they are not a guessing oracle.
    Route::post('/auth/local', [AuthController::class, 'login'])->middleware('${AUTH_THROTTLE}');
    Route::post('/auth/local/register', [AuthController::class, 'register'])->middleware('${AUTH_THROTTLE}');

    ${guard}->group(function (): void {
        Route::get('/users/me', [AuthController::class, 'me']);

${resources}
    });

    // Inside the group so hand-written routes inherit the Strapi error envelope.
    require __DIR__.'/api-custom.php';
});
`;
};
