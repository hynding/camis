<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Support\StrapiImport as Import;
use Illuminate\Console\Command;

/** Strapi's `strapi import`: reads an archive `strapi export` wrote into this app. */
final class StrapiImport extends Command
{
    protected $signature = 'strapi:import
        {--f|file= : Path and filename for the Strapi export file you want to import}
        {--k|key= : Provide encryption key in command instead of using the prompt}
        {--force : Automatically answer "yes" to all prompts, including potentially destructive requests, and run non-interactively}
        {--only= : Include only these types of data (plus schemas). Available types: content,files,config}
        {--exclude= : Exclude data using comma-separated types. Available types: content,files,config}';

    protected $description = 'Import data from a Strapi export archive';

    public function handle(): int
    {
        $file = (string) $this->option('file');
        if ($file === '') {
            $this->error('Missing required option: --file');

            return self::FAILURE;
        }
        try {
            $stages = Import::stages(self::list($this->option('only')), self::list($this->option('exclude')));
            $key = $this->option('key');
            if (str_ends_with($file, '.enc') && ($key === null || $key === '')) {
                $key = (string) $this->secret('Please enter your decryption key');
            }
            $import = Import::open($file, is_string($key) && $key !== '' ? $key : null);
            $diffs = $import->schemaDiffs();
            if ($diffs !== []) {
                $this->error('The source and destination provide incompatible schemas:');
                foreach ($diffs as $diff) {
                    $this->line("  - {$diff}");
                }

                return self::FAILURE;
            }
            if (! $this->option('force') && ! $this->confirm('The import will delete your existing data! Are you sure you want to proceed?')) {
                $this->line('Aborting import.');

                return self::FAILURE;
            }
            $counts = $import->run($stages);
        } catch (\Throwable $error) {
            $this->error("Import process failed: {$error->getMessage()}");

            return self::FAILURE;
        }
        $this->table(['Type', 'Count'], array_map(fn ($type, $count) => [$type, $count], array_keys($counts), $counts));
        foreach ($import->skipped() as $type => $reason) {
            $this->line("Not imported: {$type} ({$reason})");
        }
        $this->info('Import process has been completed successfully!');

        return self::SUCCESS;
    }

    /** @return list<string>|null */
    private static function list(mixed $option): ?array
    {
        return is_string($option) && $option !== '' ? array_map('trim', explode(',', $option)) : null;
    }
}
