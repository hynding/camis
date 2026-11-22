<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use App\Support\StrapiError;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * A body of text/plain, a form or multipart is a request any page of another site may send with
 * no CORS preflight, and Laravel's json() decodes a body whatever its type: a route that reads
 * its body only as JSON would take that page's sign-in, registration or recovery mail. So the
 * body of a route this guards must say it is JSON, which only a page CORS allows can send. A form
 * post is refused on purpose, though Strapi parses one: Strapi's clients all send JSON. A request
 * with no body has nothing to read, and goes on as Strapi takes it.
 */
final class StrapiJsonBody
{
    public function handle(Request $request, Closure $next): Response
    {
        if ($request->getContent() === '' || self::json((string) $request->headers->get('Content-Type', ''))) {
            return $next($request);
        }

        throw new StrapiError(415, 'UnsupportedMediaTypeError', 'The request body must be JSON (Content-Type: application/json)');
    }

    /** application/json, or a type of it such as application/vnd.api+json, with any parameters. */
    private static function json(string $header): bool
    {
        $type = strtolower(trim(explode(';', $header, 2)[0]));

        return $type === 'application/json' || (str_starts_with($type, 'application/') && str_ends_with($type, '+json'));
    }
}
