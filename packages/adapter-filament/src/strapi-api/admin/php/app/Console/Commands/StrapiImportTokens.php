<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Support\StrapiTokenImport as Import;
use Illuminate\Console\Command;

/** Strapi's API and transfer tokens, from its database (a `strapi export` archive holds none). */
final class StrapiImportTokens extends Command
{
    protected $signature = 'strapi:import-tokens
        {--database= : The Strapi project\'s database: a SQLite file\'s path, or a URL such as mysql://user:password@host/database}
        {--encryption-key= : The Strapi project\'s ENCRYPTION_KEY, so the admin can show its API tokens\' keys again}
        {--force : Replace tokens named as ones this app has without asking}';

    protected $description = 'Import the API and transfer tokens of a Strapi project, keeping their keys';

    public function handle(): int
    {
        $database = (string) $this->option('database');
        if ($database === '') {
            $this->error('Missing required option: --database');

            return self::FAILURE;
        }
        try {
            $import = Import::open($database, is_string($this->option('encryption-key')) ? $this->option('encryption-key') : null);
            $replaced = $import->replaced();
            if ($replaced !== [] && ! $this->option('force') && ! $this->confirm('These tokens will replace the ones of the same name here: ' . implode(', ', $replaced) . '. Proceed?')) {
                $this->line('Aborting import.');

                return self::FAILURE;
            }
            $counts = $import->run();
        } catch (\Throwable $error) {
            $this->error("Token import failed: {$error->getMessage()}");

            return self::FAILURE;
        }
        $this->table(['Tokens', 'Count'], [['API tokens', $counts['api']], ['Transfer tokens', $counts['transfer']]]);
        foreach ($import->skipped() as $token => $reason) {
            $this->line("Not imported: {$token} ({$reason})");
        }
        foreach ($import->notes() as $note) {
            $this->warn($note);
        }
        $this->line("Their keys verify here once API_TOKEN_SALT and TRANSFER_TOKEN_SALT are the Strapi project's.");
        $this->info('Token import has been completed successfully!');

        return self::SUCCESS;
    }
}
