import { PHP_MARKER } from "../hooks/names";

/**
 * Strapi's API and transfer tokens, brought over from a Strapi project's database. `strapi export`
 * leaves admin data out of its archive, tokens among it, so `php artisan strapi:import-tokens`
 * reads Strapi's token tables directly. Both kinds of token are kept as an HMAC of the key under
 * Strapi's own salt here too, so with `API_TOKEN_SALT` and `TRANSFER_TOKEN_SALT` set to the
 * project's, every key its clients hold keeps working; given the project's `ENCRYPTION_KEY`, an
 * API token's key is decrypted and kept encrypted under this app's key, so the admin can show it
 * again. The canonical check is `transfer/token-import-vectors.json`, recorded from strapi-php.
 */

export const TOKEN_IMPORT_ENGINE_PATH = "app/Support/StrapiTokenImport.php";
export const TOKEN_IMPORT_COMMAND_PATH = "app/Console/Commands/StrapiImportTokens.php";

export const emitStrapiTokenImport = (): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n` +
  String.raw`
use App\Models\StrapiApiToken;
use App\Models\StrapiTransferToken;
use Carbon\CarbonImmutable;
use Illuminate\Database\Connection;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;

final class StrapiTokenImport
{
    private const CONNECTION = 'strapi-tokens';

    /** @var array<string, string> token → why it was not imported */
    private array $skipped = [];

    /** @var list<string> what an imported token lost on the way */
    private array $notes = [];

    private function __construct(private readonly Connection $source, private readonly ?string $encryptionKey)
    {
    }

    /**
     * Strapi's database: a SQLite file's path, or a URL (` +
  "`mysql://user:pass@host/db`" +
  String.raw`,
     * ` +
  "`pgsql://…`" +
  String.raw`, ` +
  "`sqlite:///path`" +
  String.raw`). $encryptionKey is Strapi's ENCRYPTION_KEY.
     */
    public static function open(string $database, ?string $encryptionKey = null): self
    {
        $config = is_file($database)
            ? ['driver' => 'sqlite', 'database' => $database, 'prefix' => '', 'foreign_key_constraints' => false]
            : ['url' => $database, 'prefix' => ''];
        config(['database.connections.' . self::CONNECTION => $config]);
        DB::purge(self::CONNECTION);
        $source = DB::connection(self::CONNECTION);
        if (! $source->getSchemaBuilder()->hasTable('strapi_api_tokens')) {
            throw new \RuntimeException("{$database} has no strapi_api_tokens table: is it a Strapi 5 database?");
        }

        return new self($source, $encryptionKey === '' ? null : $encryptionKey);
    }

    /** @return list<string> the names of tokens this app already has, which an import replaces */
    public function replaced(): array
    {
        $names = [
            ...StrapiApiToken::query()->whereIn('name', $this->apiTokens()->pluck('name'))->pluck('name')->all(),
            ...StrapiTransferToken::query()->whereIn('name', $this->transferTokens()->pluck('name'))->pluck('name')->all(),
        ];
        sort($names);

        return $names;
    }

    /** @return array{api: int, transfer: int} */
    public function run(): array
    {
        $counts = ['api' => 0, 'transfer' => 0];
        DB::transaction(function () use (&$counts): void {
            $actions = $this->actions('strapi_api_token_permissions', 'api_token');
            foreach ($this->apiTokens() as $row) {
                // An admin token (Strapi 5.40's kind) acts in the admin, which this app's tokens do not.
                if (($row->kind ?? 'content-api') !== 'content-api') {
                    $this->skipped["API token {$row->name}"] = 'an admin token: this app\'s API tokens reach the Content API only';

                    continue;
                }
                StrapiApiToken::query()->where('name', $row->name)->delete();
                (new StrapiApiToken())->forceFill([
                    'name' => $row->name,
                    'description' => (string) ($row->description ?? ''),
                    'type' => $row->type,
                    'access_key' => $row->access_key,
                    'encrypted_key' => $this->reencrypt($row->name, $row->encrypted_key ?? null),
                    'permissions' => $row->type === 'custom' ? ($actions[$row->id] ?? []) : null,
                ] + self::times($row))->saveQuietly();
                $counts['api']++;
            }
            $permissions = $this->actions('strapi_transfer_token_permissions', 'transfer_token');
            foreach ($this->transferTokens() as $row) {
                StrapiTransferToken::query()->where('name', $row->name)->delete();
                (new StrapiTransferToken())->forceFill([
                    'name' => $row->name,
                    'description' => (string) ($row->description ?? ''),
                    'access_key' => $row->access_key,
                    'permissions' => StrapiTransferTokens::permissions($permissions[$row->id] ?? []),
                ] + self::times($row))->saveQuietly();
                $counts['transfer']++;
            }
        });

        return $counts;
    }

    /** @return array<string, string> */
    public function skipped(): array
    {
        ksort($this->skipped);

        return $this->skipped;
    }

    /** @return list<string> */
    public function notes(): array
    {
        return $this->notes;
    }

    /** @return \Illuminate\Support\Collection<int, object> */
    private function apiTokens(): \Illuminate\Support\Collection
    {
        return $this->source->table('strapi_api_tokens')->orderBy('id')->get();
    }

    /** @return \Illuminate\Support\Collection<int, object> */
    private function transferTokens(): \Illuminate\Support\Collection
    {
        return $this->source->getSchemaBuilder()->hasTable('strapi_transfer_tokens')
            ? $this->source->table('strapi_transfer_tokens')->orderBy('id')->get()
            : collect();
    }

    /**
     * Each token's actions, in the order Strapi lists them: a permission row per action, joined to
     * its token through Strapi's link table.
     *
     * @return array<int|string, list<string>> token id → actions
     */
    private function actions(string $table, string $owner): array
    {
        $link = "{$table}_token_lnk";
        if (! $this->source->getSchemaBuilder()->hasTable($link)) {
            return [];
        }
        $permission = substr($owner, 0, -strlen('token')) . 'token_permission';
        $rows = $this->source->table($link)
            ->join($table, "{$table}.id", '=', "{$link}.{$permission}_id")
            ->orderBy("{$link}.{$owner}_id")->orderBy("{$link}.{$permission}_ord")->orderBy("{$link}.id")
            ->get(["{$link}.{$owner}_id as token", "{$table}.action as action"]);
        $actions = [];
        foreach ($rows as $row) {
            $actions[$row->token][] = (string) $row->action;
        }

        return array_map(fn (array $list): array => array_values(array_unique($list)), $actions);
    }

    /** Strapi's ` +
  "`v1:<iv>:<ciphertext>:<tag>`" +
  String.raw` (AES-256-GCM under a SHA-256 of its ENCRYPTION_KEY), kept under this app's key. */
    private function reencrypt(string $name, ?string $encrypted): ?string
    {
        if ($encrypted === null || $encrypted === '') {
            return null;
        }
        if ($this->encryptionKey === null) {
            $this->notes[] = "API token {$name}: its key works, but the admin cannot show it again without the Strapi project's ENCRYPTION_KEY (--encryption-key)";

            return null;
        }
        [$version, $iv, $ciphertext, $tag] = array_pad(explode(':', $encrypted), 4, '');
        $plain = $version === 'v1'
            ? openssl_decrypt((string) hex2bin($ciphertext), 'aes-256-gcm', hash('sha256', $this->encryptionKey, true), OPENSSL_RAW_DATA, (string) hex2bin($iv), (string) hex2bin($tag))
            : false;
        if ($plain === false) {
            $this->notes[] = "API token {$name}: its key works, but this ENCRYPTION_KEY does not decrypt it, so the admin cannot show it again";

            return null;
        }

        return Crypt::encryptString($plain);
    }

    /** @return array<string, mixed> */
    private static function times(object $row): array
    {
        return [
            'last_used_at' => self::time($row->last_used_at ?? null),
            'expires_at' => self::time($row->expires_at ?? null),
            'lifespan' => ($row->lifespan ?? null) === null ? null : (int) $row->lifespan,
            'created_at' => self::time($row->created_at ?? null) ?? CarbonImmutable::now(),
            'updated_at' => self::time($row->updated_at ?? null) ?? CarbonImmutable::now(),
        ];
    }

    /** A Strapi datetime: milliseconds since the epoch on SQLite, a date string elsewhere. */
    private static function time(mixed $value): ?CarbonImmutable
    {
        if ($value === null || $value === '') {
            return null;
        }

        return is_numeric($value) ? CarbonImmutable::createFromTimestampMs((int) $value) : CarbonImmutable::parse((string) $value, 'UTC');
    }
}
`;

/** The command: where Strapi's database is, its encryption key, and a summary. */
export const emitStrapiImportTokensCommand = (): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\Console\\Commands;\n` +
  String.raw`
use App\Support\StrapiTokenImport as Import;
use Illuminate\Console\Command;

/** Strapi's API and transfer tokens, from its database (a ` +
  "`strapi export`" +
  String.raw` archive holds none). */
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
`;
