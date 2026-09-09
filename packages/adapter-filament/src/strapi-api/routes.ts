import type { StorageLayout } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { filamentNames } from "../names";
import { routePath } from "./names";

/** Default requests per minute allowed on the unauthenticated credential endpoints. */
const AUTH_THROTTLE_PER_MINUTE = 10;

/**
 * Laravel's unnamed `throttle:N,1` keys on the client IP alone, so one hard-coded rate is
 * wrong for every deployment at once — too loose behind a per-user address, low enough to
 * lock out a shared NAT or an acceptance suite that registers an account per test. The rate
 * is an operational knob, so it lives in config (env-overridable, and read through `config()`
 * so `config:cache` keeps working). It is floored at 1: `(int)` turns an empty or non-numeric
 * env value into 0, and `throttle:0,1` means "reject everything", not "no limit".
 *
 * On the Strapi storage layout, two more keys are appended: `jwt_secret`, the HS256 secret
 * shared with the Strapi instance so a session minted by either app is accepted by both (read
 * by `App\Http\Middleware\StrapiJwtGuard` and the Strapi-storage `AuthController::session()`),
 * and `email_confirmation`, mirroring Strapi's own users-permissions advanced setting.
 */
export const emitApiConfig = (layout: StorageLayout = "laravel"): string => {
  const strapiKeys =
    layout === "strapi"
      ? `

    // Shared with Strapi: the HS256 secret both apps sign and verify JWTs with.
    'jwt_secret' => (string) env('JWT_SECRET', ''),

    // Mirrors Strapi's own users-permissions "Enable email confirmation" advanced setting.
    'email_confirmation' => (bool) env('CAMIS_EMAIL_CONFIRMATION', false),`
      : "";

  return `<?php

// @camis:generated — do not edit.

declare(strict_types=1);

return [
    // Requests per minute allowed on the unauthenticated credential endpoints
    // (POST /auth/local and /auth/local/register), keyed by client address.
    'auth_throttle_per_minute' => max(1, (int) env('CAMIS_AUTH_THROTTLE_PER_MINUTE', ${AUTH_THROTTLE_PER_MINUTE})),${strapiKeys}
];
`;
};

/**
 * The guard on the authenticated route group. `auth:sanctum` is the Laravel-layout default; the
 * Strapi storage layout authenticates the JWT Strapi itself issued, so it swaps in the generated
 * `StrapiJwtGuard` middleware instead of a Laravel guard name.
 */
export type RouteGuard = "auth:sanctum" | "strapi-jwt";

export const emitStrapiRoutes = (
  cts: ContentType[],
  secured: boolean,
  guard: RouteGuard = "auth:sanctum",
): string => {
  const jwt = secured && guard === "strapi-jwt";
  const sorted = [...cts].sort((a, b) => routePath(a).localeCompare(routePath(b)));
  const uses = [
    "App\\Http\\Controllers\\Api\\AuthController",
    ...sorted.map((ct) => `App\\Http\\Controllers\\Api\\${filamentNames(ct).model}ApiController`),
    "App\\Http\\Middleware\\StrapiErrors",
    ...(jwt ? ["App\\Http\\Middleware\\StrapiJwtGuard"] : []),
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
  const group = !secured
    ? "Route::middleware([])"
    : jwt
      ? "Route::middleware(StrapiJwtGuard::class)"
      : "Route::middleware('auth:sanctum')";
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

// The only unauthenticated credential endpoints: throttled so they are not a guessing oracle.
// The rate is deployment-specific — see config/camis.php.
$authThrottle = 'throttle:'.(int) config('camis.auth_throttle_per_minute', ${AUTH_THROTTLE_PER_MINUTE}).',1';

Route::middleware([StrapiErrors::class])->group(function () use ($authThrottle): void {
    Route::get('/_health', fn () => response()->noContent());
    Route::post('/auth/local', [AuthController::class, 'login'])->middleware($authThrottle);
    Route::post('/auth/local/register', [AuthController::class, 'register'])->middleware($authThrottle);

    ${group}->group(function (): void {
        Route::get('/users/me', [AuthController::class, 'me']);

${resources}
    });

    // Inside the group so hand-written routes inherit the Strapi error envelope.
    require __DIR__.'/api-custom.php';
});
`;
};
