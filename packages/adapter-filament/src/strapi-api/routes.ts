import type { StorageLayout } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { filamentNames } from "../names";
import { routePath } from "./names";
import { apiTokensConfigKeys } from "./api-tokens";
import { webhooksConfigKeys } from "./webhooks";
import { usersPermissionsConfigKeys } from "./users-permissions";

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
export const emitApiConfig = (
  layout: StorageLayout = "laravel",
  alwaysPopulateComponents = false,
  localized = false,
  upload = false,
  usersPermissions = false,
  apiTokens = false,
  webhooks = false,
): string => {
  // Where the media library keeps its files: unset, public/uploads, served at /uploads as Strapi's
  // local provider serves it; else a Laravel disk name (s3, …). The limit is Strapi's default.
  const uploadKeys = upload
    ? `

    'upload' => [
        'disk' => env('CAMIS_UPLOAD_DISK'),
        'provider' => env('CAMIS_UPLOAD_PROVIDER'),
        'size_limit' => (int) env('CAMIS_UPLOAD_SIZE_LIMIT', 209715200),
    ],`
    : "";
  // The locale the locales table starts with, which reads and writes use when a request names none.
  const i18nKeys = localized
    ? `

    'i18n' => [
        'default_locale' => env('CAMIS_DEFAULT_LOCALE', 'en'),
        'default_locale_name' => env('CAMIS_DEFAULT_LOCALE_NAME', 'English (en)'),
    ],`
    : "";
  const strapiKeys =
    layout === "strapi"
      ? `

    // Shared with Strapi: the HS256 secret both apps sign and verify JWTs with.
    'jwt_secret' => (string) env('JWT_SECRET', ''),

    // Mirrors Strapi's own users-permissions "Enable email confirmation" advanced setting.
    'email_confirmation' => (bool) env('CAMIS_EMAIL_CONFIRMATION', false),`
      : `

    // Strapi's api.rest config, as a new Strapi project ships it: the page size when a request
    // names none, the largest one allowed (0 = no cap), and whether lists count their total.
    'rest' => [
        'default_limit' => (int) env('CAMIS_REST_DEFAULT_LIMIT', 25),
        'max_limit' => (int) env('CAMIS_REST_MAX_LIMIT', 100),
        'with_count' => (bool) env('CAMIS_REST_WITH_COUNT', true),
        // Strapi 5 sends components only when populate names them; true keeps sending them
        // always, as camis did before, for clients written against that.
        'always_populate_components' => (bool) env('CAMIS_REST_ALWAYS_POPULATE_COMPONENTS', ${alwaysPopulateComponents}),
    ],`;

  return `<?php

// @camis:generated — do not edit.

declare(strict_types=1);

return [
    // Requests per minute allowed on the unauthenticated credential endpoints
    // (POST /auth/local and /auth/local/register), keyed by client address.
    'auth_throttle_per_minute' => max(1, (int) env('CAMIS_AUTH_THROTTLE_PER_MINUTE', ${AUTH_THROTTLE_PER_MINUTE})),${strapiKeys}${i18nKeys}${uploadKeys}${usersPermissions ? usersPermissionsConfigKeys() : ""}${apiTokens ? apiTokensConfigKeys() : ""}${webhooks ? webhooksConfigKeys() : ""}
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
  localized = false,
  upload = false,
  usersPermissions = false,
  guests = false,
): string => {
  const jwt = secured && guard === "strapi-jwt";
  const tokens = usersPermissions && secured;
  const sorted = [...cts].sort((a, b) => routePath(a).localeCompare(routePath(b)));
  const uses = [
    "App\\Http\\Controllers\\Api\\AuthController",
    ...(localized ? ["App\\Http\\Controllers\\Api\\LocaleController"] : []),
    ...(upload ? ["App\\Http\\Controllers\\Api\\UploadController"] : []),
    ...(usersPermissions
      ? [
          "App\\Http\\Controllers\\Api\\ConnectController",
          "App\\Http\\Controllers\\Api\\RoleController",
          "App\\Http\\Controllers\\Api\\SessionController",
          "App\\Http\\Controllers\\Api\\UserController",
          "App\\Http\\Middleware\\StrapiActiveUser",
          "App\\Http\\Middleware\\StrapiCredentials",
        ]
      : []),
    ...(tokens ? ["App\\Http\\Middleware\\StrapiApiToken"] : []),
    ...sorted.map((ct) => `App\\Http\\Controllers\\Api\\${filamentNames(ct).model}ApiController`),
    "App\\Http\\Middleware\\StrapiErrors",
    ...(usersPermissions
      ? [
          "Illuminate\\Cookie\\Middleware\\AddQueuedCookiesToResponse",
          "Illuminate\\Cookie\\Middleware\\EncryptCookies",
          "Illuminate\\Session\\Middleware\\StartSession",
        ]
      : []),
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
  const uploads = upload
    ? `

        Route::post('/upload', [UploadController::class, 'upload']);
        Route::get('/upload/files', [UploadController::class, 'find']);
        Route::get('/upload/files/{id}', [UploadController::class, 'findOne']);
        Route::delete('/upload/files/{id}', [UploadController::class, 'destroy']);`
    : "";
  const sanctum = tokens
    ? "Route::middleware([StrapiCredentials::class.':required', StrapiActiveUser::class])"
    : usersPermissions
      ? "Route::middleware(['auth:sanctum', StrapiActiveUser::class])"
      : "Route::middleware('auth:sanctum')";
  const group = !secured
    ? "Route::middleware([])"
    : jwt
      ? "Route::middleware(StrapiJwtGuard::class)"
      : sanctum;
  // A session's own routes need one even where nothing else is guarded.
  const own = secured ? "" : "->middleware(['auth:sanctum', StrapiActiveUser::class])";
  // Strapi grants these to its public role alone, so a session is refused on them.
  const guestOnly = usersPermissions ? ", StrapiCredentials::class.':guest'" : "";
  const throttled = usersPermissions ? `[$authThrottle${guestOnly}]` : "$authThrottle";
  const accountRoutes = usersPermissions
    ? `
    Route::post('/auth/forgot-password', [AuthController::class, 'forgotPassword'])->middleware(${throttled});
    Route::post('/auth/reset-password', [AuthController::class, 'resetPassword'])->middleware(${throttled});
    Route::get('/auth/email-confirmation', [AuthController::class, 'emailConfirmation'])->middleware(StrapiCredentials::class.':guest');
    Route::post('/auth/send-email-confirmation', [AuthController::class, 'sendEmailConfirmation'])->middleware(${throttled});
    Route::post('/auth/refresh', [SessionController::class, 'refresh'])->middleware(StrapiCredentials::class.':guest');

    // A provider's round trip is the browser's: its state and tokens are kept in a session.
    Route::middleware([EncryptCookies::class, AddQueuedCookiesToResponse::class, StartSession::class, StrapiCredentials::class.':guest'])->group(function () use ($authThrottle): void {
        Route::get('/connect/{provider}', [ConnectController::class, 'connect'])->middleware($authThrottle);
        Route::get('/connect/{provider}/callback', [ConnectController::class, 'callback'])->middleware($authThrottle);
        Route::get('/auth/{provider}/callback', [ConnectController::class, 'signIn']);
    });

    // Roles live in the IR, so no grant opens these: Strapi forbids them to the roles it ships.
    Route::middleware([StrapiCredentials::class.':optional', StrapiActiveUser::class])->group(function (): void {
        Route::match(['get', 'post'], '/users-permissions/roles', RoleController::class);
        Route::match(['get', 'put', 'delete'], '/users-permissions/roles/{role}', RoleController::class);
        Route::get('/users-permissions/permissions', RoleController::class);
    });`
    : "";
  // Without roles nothing would guard who lists or makes accounts, so the routes are left out.
  const userRoutes = `
        Route::get('/users/count', [UserController::class, 'count']);
        Route::get('/users', [UserController::class, 'find']);
        Route::post('/users', [UserController::class, 'create']);
        Route::get('/users/{id}', [UserController::class, 'findOne']);
        Route::put('/users/{id}', [UserController::class, 'update']);
        Route::delete('/users/{id}', [UserController::class, 'destroy']);`;
  const ownRoutes = `Route::get('/users/me', [UserController::class, 'me'])${own};
        Route::post('/auth/change-password', [AuthController::class, 'changePassword'])${own};
        Route::post('/auth/logout', [SessionController::class, 'logout'])${own};
        Route::get('/auth/sessions', [SessionController::class, 'sessions'])${own};
        Route::delete('/auth/sessions/{sessionId}', [SessionController::class, 'revoke'])${own};`;
  const sessionRoutes = usersPermissions
    ? `${ownRoutes}${secured && !guests ? userRoutes : ""}`
    : "Route::get('/users/me', [AuthController::class, 'me']);";
  // With a public role, content is served without a session; a session's own routes still need one.
  const groups = guests
    ? `${sanctum}->group(function (): void {
        ${ownRoutes}
    });

    Route::middleware([StrapiCredentials::class.':optional', StrapiActiveUser::class])->group(function (): void {${userRoutes.slice(1)}

${resources}${uploads}
    });`
    : `${group}->group(function (): void {
        ${sessionRoutes}

${resources}${uploads}
    });`;
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

${
  tokens
    ? `// Strapi tries an API token before a session, on every content API route: StrapiApiToken checks
// the token against the route's action, ahead of each route's own credentials.
`
    : ""
}Route::middleware([StrapiErrors::class${tokens ? ", StrapiApiToken::class" : ""}])->group(function () use ($authThrottle): void {
    Route::get('/_health', fn () => response()->noContent());
    Route::post('/auth/local', [AuthController::class, 'login'])->middleware(${throttled});
    Route::post('/auth/local/register', [AuthController::class, 'register'])->middleware(${throttled});${accountRoutes}${
      localized
        ? `

    // Strapi's i18n plugin lists the locales to anyone: they name no content.
    Route::get('i18n/locales', [LocaleController::class, 'index']);`
        : ""
    }

    ${groups}

    // Inside the group so hand-written routes inherit the Strapi error envelope.
    require __DIR__.'/api-custom.php';
});
`;
};
