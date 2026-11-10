import { PHP_MARKER } from "../hooks/names";

export const CONTENT_TYPE_BUILDER_PATH = "app/Support/ContentTypeBuilder.php";

/**
 * Where the Content-Type Builder reads the content model, and how an edit reaches the IR: written,
 * built, synced, or put back.
 */
export const emitContentTypeBuilderRuntime = (): string =>
  `<?php
${PHP_MARKER}
` +
  String.raw`
declare(strict_types=1);

namespace App\Support;

use Illuminate\Support\Facades\Process;
use RuntimeException;
use Symfony\Component\Process\PhpExecutableFinder;

/**
 * Where the Content-Type Builder reads the content model from, and how an edit reaches it.
 *
 * Read-only, the builder shows the model this app was generated from ("resources/camis/schema.json").
 * Editable, as Strapi's builder is only under "strapi develop", it needs APP_ENV=local and the
 * project "camis develop" names (CAMIS_PROJECT_CONFIG and CAMIS_BUILD_COMMAND): an edit then writes
 * the project's content model (the IR, which stays the source of truth) and its roles, runs
 * "camis build", which validates the model and regenerates every target, and brings the database
 * up to the new schema. A build that fails puts both files back as they were.
 */
final class ContentTypeBuilder
{
    public const SCHEMA_PATH = 'resources/camis/schema.json';

    /** Why the builder is read-only, or null when it may edit. */
    public static function readOnlyReason(): ?string
    {
        if (! app()->environment((array) config('content-type-builder.environments', ['local']))) {
            return 'The Content-Type Builder only edits the content model in development (APP_ENV=local); in other environments it shows the model this app was built from.';
        }
        $project = self::projectPath();
        if ($project === null || config('content-type-builder.build_command') === null) {
            return 'Run the app with "camis develop" to edit the content model here: it tells the app where the camis project is and how to rebuild it.';
        }
        if (! is_file($project)) {
            return "The camis project {$project} does not exist.";
        }
        if (! is_writable(self::paths()['ir'])) {
            return 'The content model '.self::paths()['ir'].' cannot be written.';
        }

        return null;
    }

    public static function editable(): bool
    {
        return self::readOnlyReason() === null;
    }

    /**
     * The content model the builder shows: the project's while it may edit, else the one this app
     * was built from.
     *
     * @return array<string, mixed>
     */
    public static function document(): array
    {
        return self::decode(self::editable() ? self::paths()['ir'] : base_path(self::SCHEMA_PATH));
    }

    /**
     * Apply an edit to the content model (and the roles, for the content type it made or changed),
     * build the project, and bring the database up to it. Returns the new content model.
     *
     * @param  callable(array<string, mixed>): array<string, mixed>  $change
     * @param  (callable(array<string, mixed>): ?string)|null  $touched  the content type the edit made or changed
     * @return array<string, mixed>
     *
     * @throws RuntimeException when the builder is read-only, or the build fails (nothing is kept)
     * @throws \InvalidArgumentException when the edit is refused
     */
    public static function apply(callable $change, ?callable $touched = null): array
    {
        $reason = self::readOnlyReason();
        if ($reason !== null) {
            throw new RuntimeException($reason);
        }
        $paths = self::paths();
        $before = ['ir' => (string) file_get_contents($paths['ir'])];
        $ir = $change(self::decode($paths['ir']));
        $writes = ['ir' => ContentTypeBuilderSchema::encode($ir)];
        if ($paths['roles'] !== null && is_file($paths['roles'])) {
            $before['roles'] = (string) file_get_contents($paths['roles']);
            $roles = ContentTypeBuilderSchema::syncRoles(self::decode($paths['roles']), $ir, $touched === null ? null : $touched($ir));
            $writes['roles'] = ContentTypeBuilderSchema::encode($roles);
        }
        foreach ($writes as $key => $content) {
            file_put_contents((string) $paths[$key], $content);
        }

        $build = Process::path(dirname((string) self::projectPath()))
            ->timeout((int) config('content-type-builder.timeout', 300))
            ->run((string) config('content-type-builder.build_command'));
        if (! $build->successful()) {
            foreach ($before as $key => $content) {
                file_put_contents((string) $paths[$key], $content);
            }
            throw new RuntimeException("camis build failed, so the content model was left as it was:\n".trim($build->output()."\n".$build->errorOutput()));
        }

        // A fresh PHP process, as the build has just rewritten the app's classes and migrations.
        $sync = Process::path(base_path())
            ->timeout((int) config('content-type-builder.timeout', 300))
            ->run([(new PhpExecutableFinder)->find(false) ?: 'php', 'artisan', 'camis:schema-sync', '--force']);
        if (! $sync->successful()) {
            throw new RuntimeException("The project was rebuilt, but the database could not be brought up to it:\n".trim($sync->output()."\n".$sync->errorOutput()));
        }

        return $ir;
    }

    private static function projectPath(): ?string
    {
        $project = config('content-type-builder.project');

        return is_string($project) && $project !== '' ? $project : null;
    }

    /**
     * The content model and roles files the project config names, relative to it.
     *
     * @return array{ir: string, roles: string|null}
     */
    private static function paths(): array
    {
        $project = (string) self::projectPath();
        $config = self::decode($project);
        $resolve = fn (string $path): string => str_starts_with($path, '/') ? $path : dirname($project).'/'.$path;

        return [
            'ir' => $resolve((string) ($config['ir'] ?? throw new RuntimeException("{$project} names no content model (ir)"))),
            'roles' => isset($config['roles']) ? $resolve((string) $config['roles']) : null,
        ];
    }

    /** @return array<string, mixed> */
    private static function decode(string $path): array
    {
        $content = @file_get_contents($path);
        if ($content === false) {
            throw new RuntimeException("cannot read {$path}");
        }
        $decoded = json_decode($content, true, flags: JSON_THROW_ON_ERROR);
        if (! is_array($decoded)) {
            throw new RuntimeException("{$path} is not a JSON object");
        }

        return $decoded;
    }
}
`;
