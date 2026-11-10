import { PHP_MARKER } from "../hooks/names";

export const SCHEMA_SYNC_COMMAND_PATH = "app/Console/Commands/CamisSchemaSync.php";
export const SCHEMA_SYNC_PATH = "app/Support/CamisSchemaSync.php";

/**
 * Brings the database up to the generated migrations after the content model changed, keeping the
 * data, as Strapi's schema sync does.
 */
export const emitSchemaSync = (): string =>
  `<?php
${PHP_MARKER}
` +
  String.raw`
declare(strict_types=1);

namespace App\Support;

use Closure;
use Illuminate\Database\Connection;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Database\Schema\Builder;
use Illuminate\Database\Schema\ColumnDefinition;
use Illuminate\Support\Facades\Schema;
use Throwable;

/**
 * Brings the database up to the generated migrations after the content model changed, keeping the
 * data, as Strapi's schema sync does when its Content-Type Builder restarts the server.
 *
 * camis generates one create migration per table, numbered in the model's order, so a new type
 * renumbers the ones after it and "php artisan migrate" would create tables that exist. Here a
 * migration is known by its name without its number. Each generated migration is replayed into a
 * recorder: a table it creates that is missing is created; one that exists gains the columns it
 * lacks (nullable, as Strapi's columns are: a required field is checked on write) and loses the
 * ones no generated migration declares any more; a table a recorded migration created that none
 * creates now is dropped. A column whose type changed keeps its type. Then the migrations table
 * lists exactly the generated migrations, so "migrate" runs only what camis did not generate.
 * Development only: a dropped field's or type's data is gone, as in Strapi.
 */
final class CamisSchemaSync
{
    private const MANIFEST = '.camis/manifest.json';

    private const MIGRATIONS_DIRECTORY = 'database/migrations/';

    /** @var list<string> */
    private array $report = [];

    public function __construct(private readonly Connection $connection) {}

    /**
     * Sync the schema; returns what changed, one line each.
     *
     * @return list<string>
     */
    public function run(): array
    {
        $this->report = [];
        $files = $this->generatedMigrations();
        $recorded = $this->recordedMigrations();
        $recordedIds = array_map(self::identity(...), $recorded);
        $plans = [];
        foreach ($files as $file) {
            $plans[$file] = $this->record($file);
        }

        $declared = [];
        $created = [];
        foreach ($plans as $plan) {
            foreach ($plan['creates'] as $table => $create) {
                $created[$table] = true;
                $declared[$table] = [...($declared[$table] ?? []), ...self::columnNames($create['blueprint'])];
            }
            foreach ($plan['alters'] as $alter) {
                $declared[$alter['table']] = [...($declared[$alter['table']] ?? []), ...self::columnNames($alter['blueprint'])];
            }
        }

        $schema = $this->connection->getSchemaBuilder();
        foreach ($plans as $file => $plan) {
            $missing = array_values(array_filter(array_keys($plan['creates']), fn (string $table): bool => ! $schema->hasTable($table)));
            if ($missing !== [] && count($missing) === count($plan['creates'])) {
                // Run as migrate would, with whatever rows the migration seeds.
                $plan['migration']->up();
                foreach ($missing as $table) {
                    $this->report[] = "created table {$table}";
                }

                continue;
            }
            foreach ($plan['creates'] as $table => $create) {
                if (in_array($table, $missing, true)) {
                    $schema->create($table, $create['callback']);
                    $this->report[] = "created table {$table}";

                    continue;
                }
                $this->addMissingColumns($table, $create['blueprint']);
            }
            if ($plan['creates'] === [] && ! in_array(self::identity($file), $recordedIds, true)) {
                foreach ($plan['alters'] as $alter) {
                    $this->applyAlteration($alter['table'], $alter['blueprint'], $alter['callback']);
                }
            }
        }
        foreach ($declared as $table => $columns) {
            if (isset($created[$table])) {
                $this->dropUndeclaredColumns($table, array_values(array_unique($columns)));
            }
        }
        $this->dropAbandonedTables($recorded, array_keys($created));
        $this->recordMigrations($files, $recorded);

        return $this->report;
    }

    /** A migration's name without its date and number: what stays when the model renumbers it. */
    public static function identity(string $migration): string
    {
        return (string) preg_replace('/^\d{4}_\d{2}_\d{2}_\d{6}_/', '', $migration);
    }

    /** @return list<string> the generated migrations' names, in the order migrate runs them */
    private function generatedMigrations(): array
    {
        $manifest = json_decode((string) @file_get_contents(base_path(self::MANIFEST)), true);
        $names = [];
        foreach ((is_array($manifest) ? $manifest['files'] ?? [] : []) as $entry) {
            $path = (string) ($entry['path'] ?? '');
            if (str_starts_with($path, self::MIGRATIONS_DIRECTORY) && str_ends_with($path, '.php') && is_file(base_path($path))) {
                $names[] = basename($path, '.php');
            }
        }
        sort($names);

        return $names;
    }

    /** @return list<string> */
    private function recordedMigrations(): array
    {
        if (! $this->connection->getSchemaBuilder()->hasTable('migrations')) {
            return [];
        }

        return $this->connection->table('migrations')->orderBy('id')->pluck('migration')->all();
    }

    /**
     * What a migration's up() would do to the schema, without doing it.
     *
     * @return array{migration: Migration, creates: array<string, array{blueprint: Blueprint, callback: Closure}>, alters: list<array{table: string, blueprint: Blueprint, callback: Closure}>}
     */
    private function record(string $name): array
    {
        $recorder = new class($this->connection) extends Builder
        {
            /** @var array<string, array{blueprint: Blueprint, callback: Closure}> */
            public array $creates = [];

            /** @var list<array{table: string, blueprint: Blueprint, callback: Closure}> */
            public array $alters = [];

            public function create($table, Closure $callback): void
            {
                $blueprint = $this->createBlueprint($table);
                $blueprint->create();
                $callback($blueprint);
                $this->creates[$table] = ['blueprint' => $blueprint, 'callback' => $callback];
            }

            public function table($table, Closure $callback): void
            {
                $blueprint = $this->createBlueprint($table);
                $callback($blueprint);
                $this->alters[] = ['table' => $table, 'blueprint' => $blueprint, 'callback' => $callback];
            }

            public function drop($table): void {}

            public function dropIfExists($table): void {}
        };

        /** @var Migration $migration */
        $migration = require base_path(self::MIGRATIONS_DIRECTORY.$name.'.php');
        $real = Schema::getFacadeRoot();
        Schema::swap($recorder);
        // Pretending, so the rows a migration seeds are not written twice. A model saved while
        // pretending gets no id back, which only the rows' own code minds: the schema is recorded.
        set_error_handler(fn (): bool => true, E_WARNING | E_NOTICE);
        try {
            $this->connection->pretend(fn () => $migration->up());
        } catch (Throwable) {
        } finally {
            restore_error_handler();
            Schema::swap($real);
        }

        return ['migration' => $migration, 'creates' => $recorder->creates, 'alters' => $recorder->alters];
    }

    /** @return list<string> */
    private static function columnNames(Blueprint $blueprint): array
    {
        $names = [];
        foreach ($blueprint->getColumns() as $column) {
            if (! ($column->get('change') ?? false)) {
                $names[] = (string) $column->get('name');
            }
        }

        return $names;
    }

    private function addMissingColumns(string $table, Blueprint $declared): void
    {
        $existing = $this->connection->getSchemaBuilder()->getColumnListing($table);
        $missing = array_values(array_filter(
            $declared->getColumns(),
            fn (ColumnDefinition $column): bool => ! in_array($column->get('name'), $existing, true),
        ));
        if ($missing === []) {
            return;
        }
        $names = array_map(fn (ColumnDefinition $column): string => (string) $column->get('name'), $missing);
        $this->connection->getSchemaBuilder()->table($table, function (Blueprint $blueprint) use ($missing): void {
            foreach ($missing as $column) {
                $attributes = $column->getAttributes();
                $blueprint->addColumn((string) $attributes['type'], (string) $attributes['name'], array_diff_key($attributes, ['type' => true, 'name' => true]))->nullable();
            }
        });
        $this->report[] = "added {$table}.".implode(", {$table}.", $names);
        $this->addForeignKeys($table, $declared, $names);
    }

    /** The foreign keys a declared table has on the columns just added; SQLite cannot add one to a table. */
    private function addForeignKeys(string $table, Blueprint $declared, array $columns): void
    {
        $keys = array_filter(
            $declared->getCommands(),
            fn ($command): bool => $command->get('name') === 'foreign' && array_diff((array) $command->get('columns'), $columns) === [],
        );
        if ($keys === [] || $this->connection->getDriverName() === 'sqlite') {
            return;
        }
        $this->connection->getSchemaBuilder()->table($table, function (Blueprint $blueprint) use ($keys): void {
            foreach ($keys as $key) {
                $foreign = $blueprint->foreign($key->get('columns'))->references($key->get('references'))->on($key->get('on'));
                if ($key->get('onDelete') !== null) {
                    $foreign->onDelete($key->get('onDelete'));
                }
            }
        });
    }

    /** A generated alteration that never ran: run it, unless what it adds is there already. */
    private function applyAlteration(string $table, Blueprint $blueprint, Closure $callback): void
    {
        $schema = $this->connection->getSchemaBuilder();
        if (! $schema->hasTable($table)) {
            return;
        }
        $added = self::columnNames($blueprint);
        if ($added !== [] && array_diff($added, $schema->getColumnListing($table)) === []) {
            return;
        }
        $schema->table($table, $callback);
        $this->report[] = "altered table {$table}";
    }

    /** @param list<string> $declared */
    private function dropUndeclaredColumns(string $table, array $declared): void
    {
        $schema = $this->connection->getSchemaBuilder();
        $undeclared = array_values(array_diff($schema->getColumnListing($table), $declared));
        if ($undeclared === []) {
            return;
        }
        $touches = fn (array $columns): bool => array_intersect($columns, $undeclared) !== [];
        $foreignKeys = array_values(array_filter($schema->getForeignKeys($table), fn (array $key): bool => $touches($key['columns'])));
        $indexes = array_values(array_filter($schema->getIndexes($table), fn (array $index): bool => ! $index['primary'] && $touches($index['columns'])));
        $schema->table($table, function (Blueprint $blueprint) use ($foreignKeys, $indexes, $undeclared): void {
            foreach ($foreignKeys as $key) {
                $blueprint->dropForeign($key['name'] ?? $key['columns']);
            }
            foreach ($indexes as $index) {
                $blueprint->dropIndex($index['name']);
            }
            $blueprint->dropColumn($undeclared);
        });
        $this->report[] = "dropped {$table}.".implode(", {$table}.", $undeclared);
    }

    /**
     * @param  list<string>  $recorded
     * @param  list<string>  $created
     */
    private function dropAbandonedTables(array $recorded, array $created): void
    {
        $schema = $this->connection->getSchemaBuilder();
        $abandoned = [];
        foreach ($recorded as $migration) {
            if (! str_starts_with($migration, '0001_01_02_') && ! str_starts_with($migration, '0001_01_03_')) {
                continue;
            }
            if (preg_match('/^create_(.+)_table$/', self::identity($migration), $match) && ! in_array($match[1], $created, true) && $schema->hasTable($match[1])) {
                $abandoned[] = $match[1];
            }
        }
        if ($abandoned === []) {
            return;
        }
        $schema->withoutForeignKeyConstraints(function () use ($schema, $abandoned): void {
            foreach (array_reverse($abandoned) as $table) {
                $schema->drop($table);
                $this->report[] = "dropped table {$table}";
            }
        });
    }

    /**
     * The migrations table lists every generated migration under its current name, and none it no
     * longer generates.
     *
     * @param  list<string>  $files
     * @param  list<string>  $recorded
     */
    private function recordMigrations(array $files, array $recorded): void
    {
        $repository = fn () => $this->connection->table('migrations');
        $current = array_flip($files);
        $stale = array_values(array_filter(
            $recorded,
            fn (string $migration): bool => ! isset($current[$migration])
                && (str_starts_with($migration, '0001_01_02_') || str_starts_with($migration, '0001_01_03_')),
        ));
        if ($stale !== []) {
            $repository()->whereIn('migration', $stale)->delete();
        }
        $missing = array_values(array_diff($files, $recorded));
        if ($missing === []) {
            return;
        }
        $batch = (int) $repository()->max('batch') + 1;
        $repository()->insert(array_map(
            fn (string $migration): array => ['migration' => $migration, 'batch' => $batch],
            $missing,
        ));
    }
}
`;

/** "php artisan camis:schema-sync": the sync, then "migrate" for the rest and the role seeder. */
export const emitSchemaSyncCommand = (): string =>
  `<?php
${PHP_MARKER}
` +
  String.raw`
declare(strict_types=1);

namespace App\Console\Commands;

use App\Support\CamisSchemaSync as SchemaSync;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * "php artisan camis:schema-sync": the database brought up to the generated migrations, keeping its
 * data, then "migrate" for the rest and the role seeder for the new types' permissions. The
 * Content-Type Builder runs it after every build.
 */
class CamisSchemaSync extends Command
{
    protected $signature = 'camis:schema-sync {--force : Run outside APP_ENV=local}';

    protected $description = 'Bring the database up to the generated migrations without losing its data (development)';

    public function handle(): int
    {
        if (! $this->laravel->environment('local') && ! $this->option('force')) {
            $this->error('camis:schema-sync drops the columns and tables of deleted fields and types; pass --force to run it outside APP_ENV=local.');

            return self::FAILURE;
        }
        if (! DB::connection()->getSchemaBuilder()->hasTable('migrations')) {
            return $this->call('migrate', ['--force' => true]);
        }
        foreach ((new SchemaSync(DB::connection()))->run() as $line) {
            $this->line($line);
        }
        $migrated = $this->call('migrate', ['--force' => true]);
        if ($migrated !== self::SUCCESS) {
            return $migrated;
        }
        if (class_exists(\Database\Seeders\RolePermissionSeeder::class)) {
            return $this->call('db:seed', ['--class' => \Database\Seeders\RolePermissionSeeder::class, '--force' => true]);
        }

        return self::SUCCESS;
    }
}
`;
