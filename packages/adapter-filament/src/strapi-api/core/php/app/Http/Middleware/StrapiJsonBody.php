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
 * post is refused on purpose, though Strapi parses one: Strapi's clients all send JSON. PHP parses
 * a form into fields and files before the app runs, leaving the raw body empty, so those and a
 * form type count as a body too. A request with no body has nothing to read, and goes on.
 */
final class StrapiJsonBody
{
    private const FORMS = ['application/x-www-form-urlencoded', 'multipart/form-data'];

    public function handle(Request $request, Closure $next): Response
    {
        $type = strtolower(trim(explode(';', (string) $request->headers->get('Content-Type', ''), 2)[0]));
        if (self::json($type) || (! in_array($type, self::FORMS, true) && self::empty($request))) {
            return $next($request);
        }

        throw new StrapiError(415, 'UnsupportedMediaTypeError', 'The request body must be JSON (Content-Type: application/json)');
    }

    /** application/json, or a type of it such as application/vnd.api+json. */
    private static function json(string $type): bool
    {
        return $type === 'application/json' || (str_starts_with($type, 'application/') && str_ends_with($type, '+json'));
    }

    private static function empty(Request $request): bool
    {
        return $request->getContent() === '' && $request->request->count() === 0 && $request->files->count() === 0;
    }
}
