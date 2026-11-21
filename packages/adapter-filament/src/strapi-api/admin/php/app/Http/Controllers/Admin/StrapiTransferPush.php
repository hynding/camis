<?php

declare(strict_types=1);

namespace App\Http\Controllers\Admin;

use App\Support\StrapiError;
use App\Support\StrapiImport;
use App\Support\StrapiTransferArchives;
use App\Support\StrapiTransferTokens;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * `strapi transfer --to` over plain HTTP, for strapi-plugin-camis: Strapi's runner is a WebSocket,
 * which PHP under FPM cannot keep open, so a push token sends an export archive here in chunks
 * instead, asks for the schema check `strapi import` makes, and applies it as `strapi import` does.
 */
final class StrapiTransferPush
{
    /** Below PHP's default post_max_size, so a host's limits never cut a chunk short. */
    public const MAX_CHUNK = 6 * 1024 * 1024;

    /** An upload nobody applied or aborted for a day is dropped. */
    private const STALE = 86400;

    public function start(Request $request): JsonResponse
    {
        StrapiTransferTokens::demand($request, 'push');
        self::dropStale();
        $id = bin2hex(random_bytes(16));
        touch(self::path($id));

        return response()->json(['data' => ['id' => $id, 'size' => 0]], 201);
    }

    /** Appends the body at ?offset=, which must be the bytes received so far: a retried chunk is refused, not doubled. */
    public function append(Request $request, string $id): JsonResponse
    {
        StrapiTransferTokens::demand($request, 'push');
        $path = self::existing($id);
        $size = self::size($path);
        $offset = $request->query('offset');
        if (! is_string($offset) || preg_match('/^\d+$/', $offset) !== 1 || (int) $offset !== $size) {
            throw StrapiError::validation("offset must be the bytes received so far ({$size})", ['size' => $size]);
        }
        $chunk = $request->getContent();
        if (strlen($chunk) > self::MAX_CHUNK) {
            throw new StrapiError(413, 'PayloadTooLargeError', 'A chunk may hold at most '.self::MAX_CHUNK.' bytes', ['max' => self::MAX_CHUNK]);
        }
        if (file_put_contents($path, $chunk, FILE_APPEND | LOCK_EX) === false) {
            throw new StrapiError(500, 'ApplicationError', 'Cannot store the chunk');
        }

        return response()->json(['data' => ['id' => $id, 'size' => self::size($path)]]);
    }

    /** What of the archive has nowhere to go here, as `strapi import` reports it before it writes anything. */
    public function check(Request $request, string $id): JsonResponse
    {
        StrapiTransferTokens::demand($request, 'push');
        $import = self::open($id);

        return response()->json(['data' => ['diffs' => $import->schemaDiffs()]]);
    }

    /** Replaces this app's data with the archive's, as `strapi import --force` does; body {only?, exclude?}. */
    public function apply(Request $request, string $id): JsonResponse
    {
        StrapiTransferTokens::demand($request, 'push');
        $stages = self::stages($request);
        $import = self::open($id);
        $diffs = $import->schemaDiffs();
        if ($diffs !== []) {
            throw StrapiError::validation('The source and destination provide incompatible schemas', ['diffs' => $diffs]);
        }
        StrapiTransferArchives::unlimited();
        try {
            $counts = $import->run($stages);
        } catch (\Throwable $error) {
            throw new StrapiError(500, 'ApplicationError', "Import process failed: {$error->getMessage()}");
        }
        @unlink(self::path($id));

        return response()->json(['data' => ['counts' => $counts, 'skipped' => (object) $import->skipped()]]);
    }

    public function abort(Request $request, string $id): Response
    {
        StrapiTransferTokens::demand($request, 'push');
        @unlink(self::existing($id));

        return response()->noContent();
    }

    /** @return list<string> */
    private static function stages(Request $request): array
    {
        $list = static function (mixed $value, string $key): ?array {
            if ($value === null) {
                return null;
            }
            if (! is_array($value) || ! array_is_list($value) || array_filter($value, 'is_string') !== $value) {
                throw StrapiError::validation("{$key} must be a list of data types");
            }

            return $value;
        };
        try {
            return StrapiImport::stages($list($request->json('only'), 'only'), $list($request->json('exclude'), 'exclude'));
        } catch (\InvalidArgumentException $error) {
            throw StrapiError::validation($error->getMessage());
        }
    }

    private static function open(string $id): StrapiImport
    {
        $path = self::existing($id);
        try {
            return StrapiImport::open($path);
        } catch (\RuntimeException $error) {
            throw StrapiError::validation($error->getMessage());
        }
    }

    private static function existing(string $id): string
    {
        $path = self::path($id);
        if (! is_file($path)) {
            throw new StrapiError(404, 'NotFoundError', 'No such push');
        }

        return $path;
    }

    private static function path(string $id): string
    {
        if (preg_match('/^[0-9a-f]{32}$/', $id) !== 1) {
            throw new StrapiError(404, 'NotFoundError', 'No such push');
        }

        return self::directory().DIRECTORY_SEPARATOR.$id.'.tar.gz';
    }

    /** Apart from the Data transfer page's archives, so a half-sent push is never offered for import there. */
    private static function directory(): string
    {
        $directory = storage_path('app/private/strapi-transfer-pushes');
        if (! is_dir($directory)) {
            mkdir($directory, 0775, true);
        }

        return $directory;
    }

    private static function size(string $path): int
    {
        clearstatcache(true, $path);

        return (int) filesize($path);
    }

    private static function dropStale(): void
    {
        foreach (glob(self::directory().DIRECTORY_SEPARATOR.'*.tar.gz') ?: [] as $path) {
            if (filemtime($path) < time() - self::STALE) {
                @unlink($path);
            }
        }
    }
}
