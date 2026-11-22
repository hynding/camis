<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Support\StrapiError;
use Closure;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Contracts\Debug\ExceptionHandler;
use Illuminate\Database\QueryException;
use Illuminate\Http\Exceptions\HttpResponseException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Throwable;

class StrapiErrors
{
    /** Strapi's admin API routes (routes/admin.php), among Filament's own /admin pages. */
    private const ADMIN_API = ['admin/init', 'admin/login', 'admin/register-admin', 'admin/users/me', 'admin/api-tokens', 'admin/api-tokens/*', 'admin/admin-tokens', 'admin/admin-tokens/*'];

    public function __construct(private readonly ExceptionHandler $handler)
    {
    }

    public function handle(Request $request, Closure $next): Response
    {
        $this->registerRenderer();

        // The MCP endpoint reads the client's Accept: it must name event streams.
        if (! $request->is('mcp')) {
            $request->headers->set('Accept', 'application/json');
        }

        return $next($request);
    }

    private function registerRenderer(): void
    {
        if (! method_exists($this->handler, 'renderable')) {
            return;
        }

        // A StrapiError is the client's mistake (a bad query or relation reference): answering it
        // is enough, and logging each one would fill a shared host's disk quota.
        if (method_exists($this->handler, 'dontReport')) {
            $this->handler->dontReport(StrapiError::class);
        }

        $this->handler->renderable(function (Throwable $e, Request $request): ?JsonResponse {
            if (! $request->is('api/*', 'graphql', 'admin/transfer/*', ...self::ADMIN_API)) {
                return null;
            }

            return match (true) {
                $e instanceof StrapiError => $this->error($e->status, $e->name, $e->getMessage(), $e->details),
                $e instanceof ValidationException => $this->error(400, 'ValidationError', collect($e->errors())->flatten()->first() ?? 'Validation failed'),
                $e instanceof QueryException => $this->error(400, 'ValidationError', 'Validation failed'),
                // Without credentials Strapi answers with the public role's verdict, and the public
                // role is granted nothing here; a token that does not verify is a 401.
                $e instanceof AuthenticationException && $request->bearerToken() === null => $this->error(403, 'ForbiddenError', 'Forbidden'),
                $e instanceof AuthenticationException => $this->error(401, 'UnauthorizedError', 'Missing or invalid credentials'),
                $e instanceof HttpResponseException => null,
                $e instanceof HttpExceptionInterface => $this->errorForStatus($e->getStatusCode(), $e->getMessage(), $e->getHeaders()),
                default => $this->error(500, 'InternalServerError', 'Internal Server Error'),
            };
        });
    }

    /**
     * Handler::render() rewrites certain framework exceptions (a missing Eloquent model, a failed
     * policy check) into equivalent HTTP exceptions before this callback ever runs, so they only
     * ever reach us here as an HttpExceptionInterface — name by the status code that survives
     * that rewrite, not by the original (already-lost) exception class. Its headers are kept: a
     * throttled request's Retry-After is how a client knows when to try again.
     *
     * @param array<string, mixed> $headers
     */
    private function errorForStatus(int $status, string $message, array $headers): JsonResponse
    {
        return match ($status) {
            401 => $this->error(401, 'UnauthorizedError', 'Missing or invalid credentials', headers: $headers),
            403 => $this->error(403, 'ForbiddenError', 'Forbidden', headers: $headers),
            404 => $this->error(404, 'NotFoundError', 'Not Found', headers: $headers),
            default => $this->error($status, 'HttpError', $message !== '' ? $message : 'Error', headers: $headers),
        };
    }

    /**
     * Strapi's error body: `data` is always null and `details` always an object.
     *
     * @param array<string, mixed> $headers
     */
    private function error(int $status, string $name, string $message, array $details = [], array $headers = []): JsonResponse
    {
        $details = $details === [] ? new \stdClass() : $details;

        $body = ['data' => null, 'error' => ['status' => $status, 'name' => $name, 'message' => $message, 'details' => $details]];

        return response()->json($body, $status, $headers);
    }
}
