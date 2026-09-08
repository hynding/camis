import { PHP_MARKER } from "../hooks/names";

/** Converts every exception on API routes into Strapi's { error: { status, name, message } } body. */
export const emitStrapiErrorsMiddleware = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Middleware;

use Closure;
use Illuminate\\Auth\\Access\\AuthorizationException;
use Illuminate\\Auth\\AuthenticationException;
use Illuminate\\Database\\Eloquent\\ModelNotFoundException;
use Illuminate\\Http\\Request;
use Illuminate\\Validation\\ValidationException;
use Symfony\\Component\\HttpFoundation\\Response;
use Symfony\\Component\\HttpKernel\\Exception\\HttpExceptionInterface;
use Throwable;

class StrapiErrors
{
    public function handle(Request $request, Closure $next): Response
    {
        try {
            return $next($request);
        } catch (ValidationException $e) {
            return $this->error(400, 'ValidationError', collect($e->errors())->flatten()->first() ?? 'Validation failed');
        } catch (AuthenticationException $e) {
            return $this->error(401, 'UnauthorizedError', 'Missing or invalid credentials');
        } catch (AuthorizationException $e) {
            return $this->error(403, 'ForbiddenError', 'Forbidden');
        } catch (ModelNotFoundException $e) {
            return $this->error(404, 'NotFoundError', 'Not Found');
        } catch (HttpExceptionInterface $e) {
            return $this->error($e->getStatusCode(), 'HttpError', $e->getMessage() !== '' ? $e->getMessage() : 'Error');
        } catch (Throwable $e) {
            report($e);

            return $this->error(500, 'InternalServerError', 'Internal Server Error');
        }
    }

    private function error(int $status, string $name, string $message): Response
    {
        return response()->json(['error' => ['status' => $status, 'name' => $name, 'message' => $message]], $status);
    }
}
`;
