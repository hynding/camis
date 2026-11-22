import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../../generate";
import { strapiApiBundle } from "../__fixtures__/strapi-api";

// Strapi 5's `jwtManagement: 'refresh'`: short access tokens, rotating refresh tokens and a list
// of the account's sessions, opt-in as in Strapi; session-vectors.json is the behaviour.
describe("users-permissions sessions", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("keeps Strapi's legacy tokens unless refresh sessions are asked for", () => {
    const config = content("config/camis.php");
    expect(config).toContain("'jwt_management' => env('CAMIS_JWT_MANAGEMENT', 'legacy-support'),");
    expect(config).toContain(
      "'access_token_lifespan' => (int) env('CAMIS_ACCESS_TOKEN_LIFESPAN', 600),",
    );
    expect(config).toContain(
      "'max_refresh_token_lifespan' => (int) env('CAMIS_MAX_REFRESH_TOKEN_LIFESPAN', 2592000),",
    );
    expect(config).toContain(
      "'idle_refresh_token_lifespan' => (int) env('CAMIS_IDLE_REFRESH_TOKEN_LIFESPAN', 1209600),",
    );
    expect(config).toContain("'http_only' => (bool) env('CAMIS_SESSIONS_HTTP_ONLY', false),");
  });

  // Strapi's legacy JWT lasts jwt.expiresIn, 30 days unless configured; a Sanctum token without an
  // expiry would last for ever. A password change or reset ends the account's other tokens.
  it("expires a legacy token as Strapi's JWT expires, and revokes them on a new password", () => {
    expect(content("config/camis.php")).toContain(
      "'jwt_lifespan' => (int) env('CAMIS_JWT_LIFESPAN', 2592000),",
    );
    const sessions = content("app/Support/StrapiSessions.php");
    expect(sessions).toContain(
      "return $user->createToken(self::LEGACY, ['*'], $lifespan > 0 ? now()->addSeconds($lifespan) : null)->plainTextToken;",
    );
    expect(sessions).toMatch(
      /public static function reissue\(User \$user\): array\n {4}\{\n {8}\$wire = \['user' => StrapiUsers::wire\(\$user\)\];\n {8}if \(! self::refreshMode\(\)\) \{\n {12}\$user->tokens\(\)->where\('name', self::LEGACY\)->delete\(\);/,
    );
  });

  // Stricter than Strapi's lax, Secure-in-production, path `/` browser-session cookie: the refresh
  // token is sent only to the auth routes, never over plain HTTP outside local development, never
  // with a request another site starts, and the browser drops it when the session can no longer
  // be refreshed. Each stays configurable.
  it("sets the refresh cookie Secure, SameSite=Strict, on the auth routes alone, by default", () => {
    const config = content("config/camis.php");
    expect(config).toContain("'secure' => (bool) env('CAMIS_SESSIONS_COOKIE_SECURE', true),");
    expect(config).toContain("'same_site' => env('CAMIS_SESSIONS_COOKIE_SAME_SITE', 'strict'),");
    expect(config).toContain("'path' => env('CAMIS_SESSIONS_COOKIE_PATH', '/api/auth'),");
    const sessions = content("app/Support/StrapiSessions.php");
    expect(sessions).toContain("|| app()->environment('local');");
  });

  it("keeps the refresh cookie as long as its session's absolute lifespan has left", () => {
    const sessions = content("app/Support/StrapiSessions.php");
    expect(sessions).toContain(
      "$expires = CarbonImmutable::parse((string) self::absoluteExpiry($refreshToken));",
    );
  });

  it("keeps sessions in their own table, timed to the millisecond as Strapi lists them", async () => {
    const migration = content(
      "database/migrations/0001_01_02_000003_create_strapi_sessions_table.php",
    );
    expect(migration).toContain("$table->string('session_id', 32)->unique();");
    expect(migration).toContain("$table->dateTime('created_at', 3);");
    await expect(migration).toMatchFileSnapshot(
      "../__golden__/strapi-api/create_strapi_sessions_table.php",
    );
  });

  it("mints an expiring Sanctum token per session and a hashed refresh token", async () => {
    const sessions = content("app/Support/StrapiSessions.php");
    expect(sessions).toContain("createToken(self::PREFIX.$sessionId, ['*'], now()->addSeconds(");
    expect(sessions).toContain("hash('sha256', $secret)");
    expect(sessions).toContain("hash_equals(");
    await expect(sessions).toMatchFileSnapshot("../__golden__/strapi-api/StrapiSessions.php");
  });

  it("names a device from its user agent as Strapi does", () => {
    const sessions = content("app/Support/StrapiSessions.php");
    expect(sessions).toContain('"{$browser} on {$os}"');
    expect(sessions).toContain("'~\\b(?:Macintosh|Mac OS X)\\b~' => 'macOS'");
  });

  it("answers the session routes with Strapi's errors, and 404 in legacy mode", async () => {
    const controller = content("app/Http/Controllers/Api/SessionController.php");
    expect(controller).toContain("'Missing refresh token'");
    expect(controller).toContain("'Invalid refresh token'");
    expect(controller).toContain("'Session not found'");
    expect(controller).toContain("throw new StrapiError(404, 'NotFoundError', 'Not Found');");
    await expect(controller).toMatchFileSnapshot("../__golden__/strapi-api/SessionController.php");
  });

  // A browser attaches the refresh cookie to a request any site makes, and on /auth/refresh it is
  // the only credential: camis takes it only from this app's origin or a CORS origin allowed
  // credentials, or, without an Origin, with a header no other site can send without a preflight.
  it("refuses the refresh cookie on a request another site could have made", () => {
    const controller = content("app/Http/Controllers/Api/SessionController.php");
    const refresh = controller.slice(controller.indexOf("public function refresh"));
    expect(refresh.indexOf("StrapiSessions::refuseForeignCookie($request);")).toBeGreaterThan(-1);
    expect(refresh.indexOf("StrapiSessions::refuseForeignCookie($request);")).toBeLessThan(
      refresh.indexOf("StrapiSessions::presented($request)"),
    );
    const sessions = content("app/Support/StrapiSessions.php");
    expect(sessions).toContain(
      "throw new StrapiError(403, 'ForbiddenError', 'The refresh cookie is not accepted from this origin');",
    );
    expect(sessions).toContain("(bool) config('cors.supports_credentials')");
    expect(sessions).toContain("$request->headers->has('X-Requested-With')");
    expect(sessions).toContain("$request->headers->has('x-strapi-refresh-cookie')");
  });

  it("issues sessions from login, registration and a password change or reset", () => {
    const auth = content("app/Http/Controllers/Api/AuthController.php");
    expect(auth).toContain("StrapiSessions::login($request, $user)");
    expect(auth).toContain("StrapiSessions::registered($request, $user)");
    expect(auth.match(/StrapiSessions::reissue\(\$user\)/g)).toHaveLength(2);
  });

  it("routes refresh as a public-only route and the rest behind a session", () => {
    const routes = content("routes/api.php");
    expect(routes).toContain(
      "Route::post('/auth/refresh', [SessionController::class, 'refresh'])->middleware([$authThrottle, StrapiCredentials::class.':guest']);",
    );
    expect(routes).toContain("Route::post('/auth/logout', [SessionController::class, 'logout']);");
    expect(routes).toContain(
      "Route::get('/auth/sessions', [SessionController::class, 'sessions']);",
    );
    expect(routes).toContain(
      "Route::delete('/auth/sessions/{sessionId}', [SessionController::class, 'revoke']);",
    );
  });

  // Roles live in the IR, so no grant opens these and nothing writes a role over HTTP. An API token
  // stands in for a role, though: strapi-php lists the roles and their permissions to a token that
  // holds those actions (a full-access one, say), and so does camis.
  it("lets a token or a role holding roles.read read the roles and permissions, and refuses every write", () => {
    const routes = content("routes/api.php");
    expect(routes).toContain(
      "Route::get('/users-permissions/roles', [RoleController::class, 'find']);",
    );
    expect(routes).toContain(
      "Route::post('/users-permissions/roles', [RoleController::class, 'createRole']);",
    );
    expect(routes).toContain(
      "Route::get('/users-permissions/roles/{role}', [RoleController::class, 'findOne']);",
    );
    expect(routes).toContain(
      "Route::put('/users-permissions/roles/{role}', [RoleController::class, 'updateRole']);",
    );
    expect(routes).toContain(
      "Route::delete('/users-permissions/roles/{role}', [RoleController::class, 'deleteRole']);",
    );
    expect(routes).toContain(
      "Route::get('/users-permissions/permissions', [RoleController::class, 'getPermissions']);",
    );
    const tokens = content("app/Support/StrapiApiTokens.php");
    expect(tokens).toContain("'find' => 'plugin::users-permissions.role.find',");
    expect(tokens).toContain("'findOne' => 'plugin::users-permissions.role.findOne',");
    expect(tokens).not.toContain("plugin::users-permissions.role.createRole");
    expect(tokens).toContain(
      "'getPermissions' => 'plugin::users-permissions.permissions.getPermissions',",
    );
    const controller = content("app/Http/Controllers/Api/RoleController.php");
    expect(controller).toContain("StrapiServices::authorize(request(), 'roles.read');");
    expect(controller).toContain("throw new StrapiError(403, 'ForbiddenError', 'Forbidden');");
  });
});
