import { runtimePhp } from "../../runtime-php";

/**
 * Strapi users-permissions' sessions (`jwtManagement: 'refresh'`, opt-in as in Strapi): each login
 * opens a session whose refresh token rotates on use, and whose access token is a Sanctum token
 * that expires within minutes. `legacy-support`, Strapi's default, keeps one token per login.
 */

export const SESSIONS_MIGRATION_PATH =
  "database/migrations/0001_01_02_000003_create_strapi_sessions_table.php";

/** Strapi's session settings and their defaults (users-permissions' constants). */
export const sessionsConfigKeys = (): string => `
        // Strapi's jwtManagement: 'legacy-support' issues one lasting token per login, 'refresh'
        // a short access token with a rotating refresh token, and lists the account's sessions.
        'jwt_management' => env('CAMIS_JWT_MANAGEMENT', 'legacy-support'),
        // How long a legacy token lasts, in seconds (Strapi's jwt.expiresIn, 30 days); 0: no expiry.
        'jwt_lifespan' => (int) env('CAMIS_JWT_LIFESPAN', 2592000),
        'sessions' => [
            'access_token_lifespan' => (int) env('CAMIS_ACCESS_TOKEN_LIFESPAN', 600),
            'max_refresh_token_lifespan' => (int) env('CAMIS_MAX_REFRESH_TOKEN_LIFESPAN', 2592000),
            'idle_refresh_token_lifespan' => (int) env('CAMIS_IDLE_REFRESH_TOKEN_LIFESPAN', 1209600),
            // The refresh token in an httpOnly cookie rather than the body (also per request,
            // with the x-strapi-refresh-cookie: httpOnly header). The cookie is stricter than
            // Strapi's: Secure (false is honoured in local development only, APP_ENV=local),
            // SameSite=Strict, sent to the auth routes alone, and kept as long as its session's
            // absolute lifespan has left rather than for the browser session.
            'http_only' => (bool) env('CAMIS_SESSIONS_HTTP_ONLY', false),
            'cookie' => [
                'name' => env('CAMIS_SESSIONS_COOKIE_NAME', 'strapi_up_refresh'),
                'secure' => (bool) env('CAMIS_SESSIONS_COOKIE_SECURE', true),
                'same_site' => env('CAMIS_SESSIONS_COOKIE_SAME_SITE', 'strict'),
                // The narrowest path that still reaches /api/auth/refresh and /api/auth/logout.
                'path' => env('CAMIS_SESSIONS_COOKIE_PATH', '/api/auth'),
                'domain' => env('CAMIS_SESSIONS_COOKIE_DOMAIN'),
            ],
        ],`;

export const emitSessionsMigration = (): string =>
  runtimePhp(
    new URL(
      "./php/database/migrations/0001_01_02_000003_create_strapi_sessions_table.php",
      import.meta.url,
    ),
  );

export const emitStrapiSessions = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiSessions.php", import.meta.url));

export const emitSessionController = (): string =>
  runtimePhp(new URL("./php/app/Http/Controllers/Api/SessionController.php", import.meta.url));

/**
 * Roles and their permissions live in the IR rather than in an editable table, so no grant can
 * open users-permissions' role routes: Strapi forbids them so to every role it ships.
 */
export const emitRoleController = (): string =>
  runtimePhp(new URL("./php/app/Http/Controllers/Api/RoleController.php", import.meta.url));
