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
    // Refreshes come often (each tab on load): a bucket of their own, at a rate of their own.
    expect(config).toContain(
      "'refresh_throttle_per_minute' => max(1, (int) env('CAMIS_REFRESH_THROTTLE_PER_MINUTE', 60)),",
    );
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
    expect(sessions).toContain("|| ! app()->environment('local');");
  });

  it("keeps the refresh cookie as long as its session's absolute lifespan has left", () => {
    const sessions = content("app/Support/StrapiSessions.php");
    expect(sessions).toContain("'expiresAt' => (string) $current->absolute_expires_at]");
    expect(sessions).toContain("'expiresAt' => $absolute];");
  });

  // A browser replaces a cookie only with one that matches it: SameSite=None needs Secure, and a
  // clearing cookie at another path or domain leaves the refresh token in place.
  it("clears the refresh cookie with the attributes it was set with", () => {
    const sessions = content("app/Support/StrapiSessions.php");
    const forget = sessions.slice(sessions.indexOf("public static function forget"));
    expect(forget.slice(0, forget.indexOf("\n    }\n"))).toContain("self::make(null, 1)");
  });

  // The expiry is the one the session was just given: a second read could miss it (a replica
  // behind), and Max-Age=0 would drop the cookie at once.
  it("sets the cookie's expiry from the session it issued, and the browser session without one", () => {
    const sessions = content("app/Support/StrapiSessions.php");
    expect(sessions).toContain(
      "public static function cookie(string $refreshToken, ?string $expiresAt): Cookie",
    );
    expect(sessions).not.toContain("absoluteExpiry(");
  });

  // Another tab's newer sign-in may own the cookie: logout ends the access token's session and
  // clears the cookie only when it named a session this logout ended.
  it("ends the access token's own session on logout, and keeps another session's cookie", () => {
    const controller = content("app/Http/Controllers/Api/SessionController.php");
    expect(controller).toContain("$session = StrapiSessions::current($request);");
    expect(controller).toContain("StrapiSessions::cookieEnded($cookieSession)");
  });

  // A token that names no session ends itself alone, not the account's sessions nor the cookie's.
  it("ends only the access token on logout when it names no session", () => {
    const controller = content("app/Http/Controllers/Api/SessionController.php");
    expect(controller).toContain("                StrapiSessions::dropAccessToken($request);");
    expect(controller).not.toContain("$session === null ? StrapiSessions::invalidate($user)");
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

  // Strapi's answers carry no lifetime, so a client learns an access token has expired only by a
  // 401; camis adds the seconds it lasts, under a name Strapi does not use.
  it("tells a client how many seconds its access token lasts, in refresh mode alone", () => {
    const sessions = content("app/Support/StrapiSessions.php");
    expect(sessions).toContain("'expiresIn' => self::lifespan('access_token_lifespan')");
    expect(sessions).toContain("return response()->json(['jwt' => self::lasting($user)] + $wire);");
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

  // An operator upgrading must learn what changed, and how to configure it, without reading PHP.
  it("documents the refresh cookie, its CSRF defence, CORS and the throttled routes in DEPLOY.md", () => {
    const deploy = content("DEPLOY.md");
    for (const knob of [
      "CAMIS_CORS_ORIGIN",
      "CAMIS_CORS_CREDENTIALS",
      "CAMIS_SESSIONS_HTTP_ONLY",
      "CAMIS_SESSIONS_COOKIE_SECURE",
      "CAMIS_SESSIONS_COOKIE_SAME_SITE",
      "CAMIS_SESSIONS_COOKIE_PATH",
      "X-Requested-With",
      "x-strapi-refresh-cookie",
      "Retry-After",
      "/auth/change-password",
      "/auth/refresh",
      "/auth/local/callback",
    ])
      expect(deploy).toContain(knob);
    expect(deploy).toContain("### Upgrading");
  });

  // Each of these changes an answer a client reads, or is a setting an operator must choose, so a
  // client author and an operator upgrading must find them without reading PHP.
  it("documents hidden accounts, JSON-only auth bodies, expiresIn and assigned fields in DEPLOY.md", () => {
    const deploy = content("DEPLOY.md");
    const upgrading = deploy.slice(deploy.indexOf("### Upgrading"));
    for (const text of [
      "CAMIS_AUTH_HIDE_ACCOUNT_EXISTENCE",
      '`{"email": ..., "sent": true}`',
      "415 `UnsupportedMediaTypeError`",
      "`expiresIn`",
      "a field the grant assigns",
    ]) {
      expect(deploy).toContain(text);
      expect(upgrading).toContain(text);
    }
    // What the setting cannot hide must be said, or an operator trusts it further than it goes.
    expect(deploy).toContain(
      "Without email confirmation registration cannot answer every address the same",
    );
    expect(deploy).toContain("fastcgi_finish_request");
  });

  // Behind a proxy that Laravel does not trust every client has the proxy's address, and so one
  // bucket; the operator must learn that, and that a password change counts per account.
  it("documents the throttle's buckets, the refresh rate and trusted proxies in DEPLOY.md", () => {
    const deploy = content("DEPLOY.md");
    expect(deploy).toContain("CAMIS_REFRESH_THROTTLE_PER_MINUTE");
    expect(deploy).toContain("$middleware->trustProxies(at:");
    expect(deploy).toContain("per account");
    expect(deploy).not.toContain("shared by all of them");
  });

  // The cookie's path covers every /api/auth route, and a rate that is not a positive number is
  // floored rather than turning the throttle off: an operator must not read either the other way.
  it("says the cookie goes to every /api/auth route and a rate of 0 means 1 per minute", () => {
    const deploy = content("DEPLOY.md");
    expect(deploy).not.toContain("and `/api/auth/logout` alone");
    expect(deploy).toContain("Sent to every route under `/api/auth`");
    expect(deploy).toContain("A rate of 0, or one that is not a number, means 1 per minute");
  });

  // A turn taken before any check is one a foreign page burns from the victim's browser: only a
  // refresh that rotated nothing is counted, and only such a one is refused once the bucket is full.
  it("counts and refuses only failed refreshes, so a valid refresh token is never throttled", () => {
    const controller = content("app/Http/Controllers/Api/SessionController.php");
    expect(controller).toContain("StrapiRateLimits::refuse($request, 'refresh');");
    expect(content("routes/api.php")).not.toContain("StrapiThrottle::class.':refresh'");
  });
  // A session row swept at its absolute expiry leaves its access token in date: logout must still
  // end that token.
  it("ends the access token on logout when its session row is gone", () => {
    expect(content("app/Http/Controllers/Api/SessionController.php")).toContain(
      "if ($session === null || ! StrapiSessions::revoke($user, $session)) {",
    );
  });
  // An operator must learn how a bucket is keyed to judge who shares it, and which knob lifts the
  // ceiling an office behind one address meets.
  it("documents per-identifier keying, the address ceiling and failure-only refresh counting", () => {
    const deploy = content("DEPLOY.md");
    expect(deploy).toContain("CAMIS_AUTH_ADDRESS_THROTTLE_PER_MINUTE");
    expect(deploy).toContain("| password-reset |");
    expect(deploy).toContain("per client address and the name it gives");
    expect(deploy).toContain("Only a refresh that fails is counted");
    expect(deploy).not.toContain("A bucket counts per client address,\nexcept a password change");
  });
  // A foreign page's refused refreshes are failures of the visitor's address too; the operator
  // must not read "cannot stop" as covering a failing refresh. And many names from one address
  // are bounded by its ceiling, the bucket following the account a name finds.
  it("says what a foreign page's refreshes can and cannot stop, and what bounds many names", () => {
    const deploy = content("DEPLOY.md");
    expect(deploy).not.toContain("cannot stop that visitor's own refreshes");
    expect(deploy).toContain("may answer 429 rather than 401");
    expect(deploy).toContain("the per-address ceiling is the bound");
    // Nothing the lookup finds has a bucket: an account's other names, and names a collation
    // matches, are bounded by the ceiling alone.
    expect(deploy).not.toContain("counts against the account it finds");
    expect(deploy).not.toContain("answer alike");
    expect(deploy).toContain("whether it finds an account has no bearing on the throttle");
    expect(deploy).toContain("an account's username and email, or two names the database matches");
  });
  // The throttle counts the name a request gives, never an account it names: the docs must not
  // say otherwise, and an upgrader learns every answer that changed.
  it("says per address and name given, and lists the changed answers under Upgrading", () => {
    const deploy = content("DEPLOY.md");
    for (const stale of ["per account named", "the account it names", "with the name it looked up"])
      expect(deploy).not.toContain(stale);
    expect(deploy).toContain("per client address and the name it gives");
    const upgrading = deploy.slice(deploy.indexOf("### Upgrading"));
    expect(upgrading).toContain("Too many requests, please try again later.");
    expect(upgrading).toContain("255 characters");
    expect(upgrading).toContain("answers 400 `ValidationError`");
    const routes = content("routes/api.php");
    expect(routes).not.toContain("the account named");
    expect(routes).not.toContain("the account it names");
    expect(content("app/Http/Middleware/StrapiThrottle.php")).not.toContain(
      "the account the body names",
    );
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
      "Route::post('/auth/refresh', [SessionController::class, 'refresh'])->middleware([StrapiJsonBody::class, StrapiCredentials::class.':guest']);",
    );
    expect(routes).toContain(
      "Route::post('/auth/logout', [SessionController::class, 'logout'])->middleware([StrapiJsonBody::class]);",
    );
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
