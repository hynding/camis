import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

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

  it("keeps sessions in their own table, timed to the millisecond as Strapi lists them", async () => {
    const migration = content(
      "database/migrations/0001_01_02_000003_create_strapi_sessions_table.php",
    );
    expect(migration).toContain("$table->string('session_id', 32)->unique();");
    expect(migration).toContain("$table->timestamp('created_at', 3);");
    await expect(migration).toMatchFileSnapshot(
      "./__golden__/strapi-api/create_strapi_sessions_table.php",
    );
  });

  it("mints an expiring Sanctum token per session and a hashed refresh token", async () => {
    const sessions = content("app/Support/StrapiSessions.php");
    expect(sessions).toContain("createToken('session:'.$sessionId, ['*'], now()->addSeconds(");
    expect(sessions).toContain("hash('sha256', $secret)");
    expect(sessions).toContain("hash_equals(");
    await expect(sessions).toMatchFileSnapshot("./__golden__/strapi-api/StrapiSessions.php");
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
    await expect(controller).toMatchFileSnapshot("./__golden__/strapi-api/SessionController.php");
  });

  it("issues sessions from login, registration and a password change or reset", () => {
    const auth = content("app/Http/Controllers/Api/AuthController.php");
    expect(auth).toContain("StrapiSessions::login($request, $user)");
    expect(auth).toContain("StrapiSessions::registered($user)");
    expect(auth.match(/StrapiSessions::reissue\(\$user\)/g)).toHaveLength(2);
  });

  it("routes refresh as a public-only route and the rest behind a session", () => {
    const routes = content("routes/api.php");
    expect(routes).toContain(
      "Route::post('/auth/refresh', [SessionController::class, 'refresh'])->middleware(StrapiCredentials::class.':guest');",
    );
    expect(routes).toContain("Route::post('/auth/logout', [SessionController::class, 'logout']);");
    expect(routes).toContain(
      "Route::get('/auth/sessions', [SessionController::class, 'sessions']);",
    );
    expect(routes).toContain(
      "Route::delete('/auth/sessions/{sessionId}', [SessionController::class, 'revoke']);",
    );
  });

  it("forbids the roles and permissions routes, which no IR grant can open", () => {
    const routes = content("routes/api.php");
    expect(routes).toContain(
      "Route::match(['get', 'post'], '/users-permissions/roles', RoleController::class);",
    );
    expect(routes).toContain(
      "Route::match(['get', 'put', 'delete'], '/users-permissions/roles/{role}', RoleController::class);",
    );
    expect(routes).toContain(
      "Route::get('/users-permissions/permissions', RoleController::class);",
    );
    expect(content("app/Http/Controllers/Api/RoleController.php")).toContain(
      "throw new StrapiError(403, 'ForbiddenError', 'Forbidden');",
    );
  });
});
