import { runtimePhp } from "../runtime-php";

/**
 * Converts every exception on API routes into Strapi's { error: { status, name, message } } body.
 *
 * The envelope covers every route registered in routes/api.php or routes/api-custom.php (the
 * latter is required inside the middleware group for exactly that reason); requests to unmatched
 * paths under `/api` fall back to Laravel's default 404 shape, because no route means no
 * middleware. `HttpResponseException` (which does not implement
 * `HttpExceptionInterface`) passes through untouched so Laravel emits the response it already
 * carries, rather than this middleware re-shaping it into a 500.
 *
 * This registers a renderable callback with the bound exception handler rather than wrapping
 * `$next($request)` in try/catch: Illuminate\Routing\Pipeline renders every exception (via that
 * same handler) at the pipe/destination layer where it is thrown, before it can ever bubble up as
 * a thrown PHP exception to an outer middleware's own catch block, so a try/catch around
 * `$next()` here would never actually run.
 *
 * Registered on every request: under FPM the handler is per-request so a guard is unnecessary;
 * under a long-lived worker a static guard would be needed to avoid re-registering on the same
 * handler — revisit if this app ever runs under Octane.
 *
 * Forces `Accept: application/json` on the request before calling `$next($request)`. Without
 * it, an unauthenticated request that omits that header (as the OYL browser client always does)
 * makes `Illuminate\Auth\Middleware\Authenticate::unauthenticated()` see `expectsJson() === false`
 * and call `redirectTo()`, which calls `route('login')` — a route this generated app never
 * defines — so a `RouteNotFoundException` surfaces as a 500 instead of the intended 401. Setting
 * the header here is the standard Laravel "force JSON for API" idiom: `expectsJson()` reads it,
 * so `Authenticate` always throws `AuthenticationException` on `api/*` routes, which the
 * renderable below turns into the 401 `UnauthorizedError` envelope.
 */
export const emitStrapiErrorsMiddleware = (): string =>
  runtimePhp(new URL("./php/app/Http/Middleware/StrapiErrors.php", import.meta.url));
