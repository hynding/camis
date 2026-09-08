import { PHP_MARKER } from "../hooks/names";

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
 * `$next()` here would never actually run. Registration happens on every request rather than
 * being guarded by a process-lifetime static: under Octane/RoadRunner the container (and its
 * bound exception handler) is restored from a boot snapshot between requests, so a static guard
 * would register once and then silently go stale for every later request in that worker;
 * re-registering is free under FPM.
 */
export const emitStrapiErrorsMiddleware = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Middleware;

use Closure;
use Illuminate\\Auth\\AuthenticationException;
use Illuminate\\Contracts\\Debug\\ExceptionHandler;
use Illuminate\\Database\\QueryException;
use Illuminate\\Http\\Exceptions\\HttpResponseException;
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\Request;
use Illuminate\\Validation\\ValidationException;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\HttpKernel\\Exception\\HttpExceptionInterface;
use Throwable;

class StrapiErrors
{
    public function __construct(private readonly ExceptionHandler $handler)
    {
    }

    public function handle(Request $request, Closure $next): Response
    {
        $this->registerRenderer();

        return $next($request);
    }

    private function registerRenderer(): void
    {
        if (! method_exists($this->handler, 'renderable')) {
            return;
        }

        $this->handler->renderable(function (Throwable $e, Request $request): ?JsonResponse {
            if (! $request->is('api/*')) {
                return null;
            }

            return match (true) {
                $e instanceof ValidationException => $this->error(400, 'ValidationError', collect($e->errors())->flatten()->first() ?? 'Validation failed'),
                $e instanceof QueryException => $this->error(400, 'ValidationError', 'Validation failed'),
                $e instanceof AuthenticationException => $this->error(401, 'UnauthorizedError', 'Missing or invalid credentials'),
                $e instanceof HttpResponseException => null,
                $e instanceof HttpExceptionInterface => $this->errorForStatus($e->getStatusCode(), $e->getMessage()),
                default => $this->error(500, 'InternalServerError', 'Internal Server Error'),
            };
        });
    }

    /**
     * Handler::render() rewrites certain framework exceptions (a missing Eloquent model, a failed
     * policy check) into equivalent HTTP exceptions before this callback ever runs, so they only
     * ever reach us here as an HttpExceptionInterface — name by the status code that survives
     * that rewrite, not by the original (already-lost) exception class.
     */
    private function errorForStatus(int $status, string $message): JsonResponse
    {
        return match ($status) {
            401 => $this->error(401, 'UnauthorizedError', 'Missing or invalid credentials'),
            403 => $this->error(403, 'ForbiddenError', 'Forbidden'),
            404 => $this->error(404, 'NotFoundError', 'Not Found'),
            default => $this->error($status, 'HttpError', $message !== '' ? $message : 'Error'),
        };
    }

    private function error(int $status, string $name, string $message): JsonResponse
    {
        return response()->json(['error' => ['status' => $status, 'name' => $name, 'message' => $message]], $status);
    }
}
`;
