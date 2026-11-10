<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Support\StrapiAdminImport as Import;
use Illuminate\Console\Command;

/** Strapi's admin accounts, from its database (a `strapi export` archive holds none). */
final class StrapiImportAdmins extends Command
{
    protected $signature = 'strapi:import-admins
        {--database= : The Strapi project\'s database: a SQLite file\'s path, or a URL such as mysql://user:password@host/database}
        {--force : Replace accounts with the same email as ones this app has without asking}';

    protected $description = 'Import the admin accounts of a Strapi project, keeping their passwords and admin roles';

    public function handle(): int
    {
        $database = (string) $this->option('database');
        if ($database === '') {
            $this->error('Missing required option: --database');

            return self::FAILURE;
        }
        try {
            $import = Import::open($database);
            $replaced = $import->replaced();
            if ($replaced !== [] && ! $this->option('force') && ! $this->confirm('These accounts will replace the ones with the same email here: ' . implode(', ', $replaced) . '. Proceed?')) {
                $this->line('Aborting import.');

                return self::FAILURE;
            }
            $count = $import->run();
        } catch (\Throwable $error) {
            $this->error("Admin import failed: {$error->getMessage()}");

            return self::FAILURE;
        }
        $this->table(['Admin accounts', 'Count'], [['Imported', $count]]);
        foreach ($import->notes() as $note) {
            $this->warn($note);
        }
        $this->info('Admin import has been completed successfully!');

        return self::SUCCESS;
    }
}
