<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Support\StrapiExport as Export;
use Carbon\CarbonImmutable;
use Illuminate\Console\Command;

/** Strapi's `strapi export`: writes this app's data as the archive `strapi import` reads. */
final class StrapiExport extends Command
{
    protected $signature = 'strapi:export
        {--f|file= : Name to use for exported file (without extensions)}
        {--k|key= : Provide encryption key in command instead of using the prompt}
        {--no-encrypt : Disables "aes-128-ecb" encryption of the output file}
        {--no-compress : Disables gzip compression of output file}
        {--only= : Include only these types of data (plus schemas). Available types: content,files,config}
        {--exclude= : Exclude data using comma-separated types. Available types: content,files,config}';

    protected $description = 'Export data from this app to a Strapi export archive';

    public function handle(): int
    {
        $file = (string) ($this->option('file') ?: 'export_' . CarbonImmutable::now()->format('YmdHis'));
        try {
            $stages = Export::stages(self::list($this->option('only')), self::list($this->option('exclude')));
            $key = null;
            if (! $this->option('no-encrypt')) {
                $key = (string) ($this->option('key') ?: $this->secret('Please enter an encryption key'));
                if ($key === '') {
                    $this->error('Provide a key with --key, or export without encryption with --no-encrypt');

                    return self::FAILURE;
                }
            }
            $written = Export::write($file, $stages, ! $this->option('no-compress'), $key);
        } catch (\Throwable $error) {
            $this->error("Export process failed: {$error->getMessage()}");

            return self::FAILURE;
        }
        $this->table(['Type', 'Count'], array_map(fn ($type, $count) => [$type, $count], array_keys($written['counts']), $written['counts']));
        $this->line("Export archive is in {$written['path']}");
        $this->info('Export process has been completed successfully!');

        return self::SUCCESS;
    }

    /** @return list<string>|null */
    private static function list(mixed $option): ?array
    {
        return is_string($option) && $option !== '' ? array_map('trim', explode(',', $option)) : null;
    }
}
