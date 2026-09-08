import { describe, expect, it } from "vitest";
import { emitAuthController, emitUsernameMigration, USERNAME_MIGRATION_PATH } from "./auth";
import { emitStrapiErrorsMiddleware } from "./errors";

describe("strapi-api auth", () => {
  it("auth controller golden (with defaultRole)", async () => {
    await expect(emitAuthController("authenticated")).toMatchFileSnapshot(
      "./__golden__/strapi-api/AuthController.php",
    );
  });
  it("omits role assignment without a defaultRole", () => {
    expect(emitAuthController(undefined)).not.toContain("assignRole");
  });
  it("escapes a defaultRole containing a single quote and backslash", () => {
    expect(emitAuthController("it's-role")).toContain("assignRole('it\\'s-role')");
    expect(emitAuthController("back\\slash")).toContain("assignRole('back\\\\slash')");
  });
  it("resolves login by email first, falling back to username, deterministically", () => {
    const php = emitAuthController(undefined);
    expect(php).toContain("User::query()->where('email', $data['identifier'])->first()");
    expect(php).not.toContain("->orWhere('username'");
  });
  it("username migration golden sorts before the generated tables", async () => {
    expect(USERNAME_MIGRATION_PATH < "database/migrations/0001_01_02_000001_x.php").toBe(true);
    await expect(emitUsernameMigration()).toMatchFileSnapshot(
      "./__golden__/strapi-api/add_username_to_users_table.php",
    );
  });
  it("errors middleware golden", async () => {
    await expect(emitStrapiErrorsMiddleware()).toMatchFileSnapshot(
      "./__golden__/strapi-api/StrapiErrors.php",
    );
  });
  // Illuminate\Routing\Pipeline renders every exception (via the bound ExceptionHandler) at the
  // pipe/destination layer where it is thrown — before it can ever bubble up as a thrown PHP
  // exception to an outer middleware's own try/catch around $next(). A middleware that wraps
  // `try { return $next($request); } catch (...)` therefore never actually catches anything:
  // proven against a real Laravel 12 app in Task 11 (a wrong-password login returned Laravel's
  // default 422 validation shape, not the Strapi { error: {...} } shape). The middleware must
  // instead register a renderable callback with the exception handler, which IS consulted by
  // that same per-layer rendering.
  it("registers a renderable callback instead of relying on try/catch around $next (Illuminate\\Routing\\Pipeline renders exceptions before they reach an outer middleware's catch)", () => {
    const php = emitStrapiErrorsMiddleware();
    expect(php).toContain("->renderable(");
    expect(php).not.toMatch(/try\s*\{\s*return \$next\(\$request\);/);
  });
  // Handler::render() calls prepareException($e) BEFORE renderViaCallbacks(), rewriting
  // ModelNotFoundException -> NotFoundHttpException and AuthorizationException ->
  // AccessDeniedHttpException — so by the time our callback runs, neither instanceof check can
  // ever be true; both always land in the generic HttpExceptionInterface arm. Name by HTTP status
  // instead of (already-lost) exception class, and delete the dead arms/imports.
  it("names HttpExceptionInterface errors by status code, not by the (already-rewritten) original exception class", () => {
    const php = emitStrapiErrorsMiddleware();
    expect(php).toContain("NotFoundError");
    expect(php).toContain("ForbiddenError");
    expect(php).not.toContain("ModelNotFoundException");
    expect(php).not.toContain("AuthorizationException");
  });
  // Under FPM the exception handler is built fresh per request, so a guard would protect nothing;
  // under a long-lived worker (Octane) the same handler instance survives, and re-registering per
  // request would grow its renderCallbacks by one entry per request — that is the case a static
  // guard exists for. This app targets FPM, so there is no guard; revisit under Octane.
  it("registers per request with no static guard (correct under FPM; revisit under Octane)", () => {
    expect(emitStrapiErrorsMiddleware()).not.toContain("static bool $registered");
  });
  // A missing required column reaches the handler as a QueryException (a NOT NULL violation from
  // the driver), which without an arm falls into `default` and becomes a 500 — the caller sent a
  // bad request, so it must be a 400. The message is fixed so raw SQL never reaches the wire.
  it("maps QueryException to a 400 ValidationError with no SQL text on the wire", () => {
    const php = emitStrapiErrorsMiddleware();
    expect(php).toContain("use Illuminate\\Database\\QueryException;");
    expect(php).toMatch(
      /QueryException\s*=>\s*\$this->error\(400, 'ValidationError', 'Validation failed'\)/,
    );
    const arm = php.split("\n").find((l) => l.includes("$e instanceof QueryException"))!;
    expect(arm).not.toContain("getMessage");
  });
  // HttpResponseException does not implement HttpExceptionInterface, so without an explicit arm
  // it falls into `default` and gets mis-shaped as a 500 — it must instead pass through (return
  // null) so Laravel's default handling emits the response the exception already carries.
  it("passes HttpResponseException through instead of mis-shaping it as a 500", () => {
    const php = emitStrapiErrorsMiddleware();
    expect(php).toContain("HttpResponseException");
    expect(php).toMatch(/HttpResponseException\s*=>\s*null/);
  });
});
