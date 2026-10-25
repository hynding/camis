import type { CapabilityGap } from "@camis/ir-schema";
import { PHP_MARKER } from "../hooks/names";

/**
 * Strapi 5's transfer tokens (the admin's Transfer Tokens settings and its `data-transfer`
 * strategy): a token may push data in, pull it out, or both, through `strapi transfer`'s runner at
 * /admin/transfer/runner/*. The runner itself is a WebSocket, which PHP under FPM cannot keep open,
 * so a valid token is answered as strapi-php answers it there: refused with 501, pointing at the
 * archive commands that move the same data.
 */

export const TRANSFER_TOKENS_MIGRATION_PATH =
  "database/migrations/0001_01_02_000007_create_strapi_transfer_tokens_table.php";

export const TRANSFER_ROUTES_PATH = "routes/transfer.php";

/** Strapi's own key: a project moving off Strapi keeps its salt, and so its tokens' hashes. */
export const transferTokensConfigKeys = (): string => `

    // The salt of every transfer token's hash (Strapi's admin.transfer.token.salt); unset, the app key.
    'transfer_tokens' => [
        'salt' => env('TRANSFER_TOKEN_SALT'),
    ],`;

export const remoteTransferGap: CapabilityGap = {
  feature: "remoteDataTransfer",
  location: {},
  severity: "downgrade",
  message:
    "`strapi transfer --to/--from` needs a server that keeps a WebSocket open, which PHP under FPM does not; " +
    "transfer tokens are kept and checked, and the data moves as an archive (`php artisan strapi:export`, `strapi import`).",
};

export const emitTransferTokensMigration = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('strapi_transfer_tokens', function (Blueprint $table): void {
            $table->id();
            $table->string('name')->unique();
            $table->string('description')->default('');
            $table->string('access_key', 128)->unique();
            $table->json('permissions');
            $table->dateTime('last_used_at')->nullable();
            $table->dateTime('expires_at')->nullable();
            $table->unsignedBigInteger('lifespan')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('strapi_transfer_tokens');
    }
};
`;

export const emitTransferTokenModel = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

/** A transfer token; as in Strapi, its key is kept only as a hash and shown once. */
final class StrapiTransferToken extends Model
{
    protected $table = 'strapi_transfer_tokens';

    protected $fillable = ['name', 'description', 'permissions'];

    protected $hidden = ['access_key'];

    protected function casts(): array
    {
        return [
            'permissions' => 'array',
            'last_used_at' => 'datetime',
            'expires_at' => 'datetime',
            'lifespan' => 'integer',
        ];
    }
}
`;

export const emitStrapiTransferTokens = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

use App\\Models\\StrapiTransferToken;
use Illuminate\\Http\\Request;
use InvalidArgumentException;

/** Strapi's transfer tokens (admin's transfer token service and data-transfer strategy). */
final class StrapiTransferTokens
{
    public const PERMISSIONS = ['push', 'pull'];

    /** The lifespans the admin offers, in milliseconds as Strapi keeps them; none never expires. */
    public const LIFESPANS = [7 * 86400000, 30 * 86400000, 90 * 86400000];

    /**
     * @param array{name: string, description?: string|null, permissions: list<string>, lifespan?: int|null} $attributes
     * @return array{token: StrapiTransferToken, accessKey: string}
     */
    public static function create(array $attributes): array
    {
        $lifespan = $attributes['lifespan'] ?? null;
        $key = self::newKey();
        $token = new StrapiTransferToken();
        $token->forceFill([
            'name' => $attributes['name'],
            'description' => $attributes['description'] ?? '',
            'permissions' => self::permissions($attributes['permissions']),
            'lifespan' => self::lifespan($lifespan),
            'expires_at' => $lifespan === null ? null : now()->addMilliseconds($lifespan),
            'access_key' => self::hash($key),
        ])->save();

        return ['token' => $token, 'accessKey' => $key];
    }

    /** A new key for the token; the old one stops verifying at once. */
    public static function regenerate(StrapiTransferToken $token): string
    {
        $key = self::newKey();
        $token->forceFill(['access_key' => self::hash($key)])->save();

        return $key;
    }

    /**
     * @param list<string> $permissions
     * @return list<string>
     */
    public static function permissions(array $permissions): array
    {
        $permissions = array_values(array_unique($permissions));
        if ($permissions === [] || array_diff($permissions, self::PERMISSIONS) !== []) {
            throw new InvalidArgumentException('A transfer token needs push, pull or both');
        }

        return $permissions;
    }

    public static function hash(string $key): string
    {
        return hash_hmac('sha512', $key, (string) (config('camis.transfer_tokens.salt') ?: config('app.key')));
    }

    /** The request's transfer token, refusing an expired one; null when it presents none. */
    public static function authenticate(Request $request): ?StrapiTransferToken
    {
        $key = $request->bearerToken();
        if ($key === null || $key === '') {
            return null;
        }
        $token = StrapiTransferToken::query()->where('access_key', self::hash($key))->first();
        if ($token === null) {
            return null;
        }
        if ($token->expires_at !== null && $token->expires_at->isPast()) {
            throw new StrapiError(401, 'UnauthorizedError', 'Token expired');
        }
        // A use is recorded at most hourly, as for API tokens.
        if ($token->last_used_at === null || $token->last_used_at->lte(now()->subHour())) {
            $token->forceFill(['last_used_at' => now()])->saveQuietly();
        }

        return $token;
    }

    public static function allows(StrapiTransferToken $token, string $scope): bool
    {
        return in_array($scope, $token->permissions ?? [], true);
    }

    private static function lifespan(?int $lifespan): ?int
    {
        if ($lifespan !== null && ! in_array($lifespan, self::LIFESPANS, true)) {
            throw new InvalidArgumentException('lifespan must be one of 7, 30 or 90 days, or none');
        }

        return $lifespan;
    }

    private static function newKey(): string
    {
        return bin2hex(random_bytes(128));
    }
}
`;

export const emitStrapiTransferRunner = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Admin;

use App\\Support\\StrapiError;
use App\\Support\\StrapiTransferTokens;
use Illuminate\\Http\\Request;

/**
 * Strapi's transfer runner, GET /admin/transfer/runner/{push,pull}: the token is checked as
 * Strapi checks it, and a valid one is told the WebSocket the runner needs is not kept here.
 */
final class StrapiTransferRunner
{
    public function push(Request $request): never
    {
        $this->refuse($request, 'push');
    }

    public function pull(Request $request): never
    {
        $this->refuse($request, 'pull');
    }

    private function refuse(Request $request, string $scope): never
    {
        $token = StrapiTransferTokens::authenticate($request);
        if ($token === null) {
            throw new StrapiError(401, 'UnauthorizedError', 'Missing or invalid credentials');
        }
        if (! StrapiTransferTokens::allows($token, $scope)) {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }
        throw new StrapiError(501, 'NotImplementedError', 'Remote data transfer needs a server that keeps a WebSocket open, which this PHP host does not: '
            .'export an archive with \`php artisan strapi:export\` (or the admin\\'s Data transfer page) and load it with \`strapi import\`, or the other way round.');
    }
}
`;

export const emitTransferRoutes = (): string => `<?php

// @camis:generated — do not edit. bootstrap/app.php loads this file (see camis scaffold).

declare(strict_types=1);

use App\\Http\\Controllers\\Admin\\StrapiTransferRunner;
use App\\Http\\Middleware\\StrapiErrors;
use Illuminate\\Support\\Facades\\Route;

// Strapi's transfer runner, beside Filament's own /admin routes; the token is its only credential.
Route::middleware([StrapiErrors::class])->group(function (): void {
    Route::get('/admin/transfer/runner/push', [StrapiTransferRunner::class, 'push']);
    Route::get('/admin/transfer/runner/pull', [StrapiTransferRunner::class, 'pull']);
});
`;

const page = (cls: string, base: string, uses: string[], body: string): string => `<?php

declare(strict_types=1);

namespace App\\Filament\\Resources\\TransferTokens\\Pages;

${[
  "App\\Filament\\Resources\\TransferTokens\\TransferTokenResource",
  `Filament\\Resources\\Pages\\${base}`,
  ...uses,
]
  .sort()
  .map((u) => `use ${u};`)
  .join("\n")}

class ${cls} extends ${base}
{
    protected static string $resource = TransferTokenResource::class;${body}
}
`;

// Strapi keeps no copy of a transfer token's key, so it is shown when made and when regenerated only.
const showKey = `
    private function showKey(string $key): void
    {
        Notification::make()->success()->persistent()
            ->title('Copy your transfer token')
            ->body($key)
            ->send();
    }`;

/**
 * The admin's Transfer Tokens settings (Strapi's Settings › Transfer Tokens), for whoever may
 * change accounts: a push token can overwrite every row, as an administrator can.
 */
export const emitTransferTokenResourceFiles = (): { path: string; content: string }[] => [
  {
    path: "app/Filament/Resources/TransferTokens/TransferTokenResource.php",
    content: `<?php

declare(strict_types=1);

namespace App\\Filament\\Resources\\TransferTokens;

use App\\Filament\\Resources\\TransferTokens\\Pages\\CreateTransferToken;
use App\\Filament\\Resources\\TransferTokens\\Pages\\EditTransferToken;
use App\\Filament\\Resources\\TransferTokens\\Pages\\ListTransferTokens;
use App\\Models\\StrapiTransferToken;
use BackedEnum;
use Filament\\Forms\\Components\\CheckboxList;
use Filament\\Forms\\Components\\Select;
use Filament\\Forms\\Components\\TextInput;
use Filament\\Resources\\Resource;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Columns\\TextColumn;
use Filament\\Tables\\Table;
use Illuminate\\Database\\Eloquent\\Model;
use UnitEnum;

class TransferTokenResource extends Resource
{
    protected static ?string $model = StrapiTransferToken::class;

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-arrows-right-left';

    protected static string | UnitEnum | null $navigationGroup = 'Settings';

    protected static ?string $navigationLabel = 'Transfer Tokens';

    protected static ?string $modelLabel = 'transfer token';

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('name')->required()->unique(ignoreRecord: true),
            TextInput::make('description'),
            Select::make('lifespan')->label('Token duration')
                ->options([604800000 => '7 days', 2592000000 => '30 days', 7776000000 => '90 days'])
                ->placeholder('Unlimited')
                ->visibleOn('create'),
            CheckboxList::make('permissions')->label('Token type')
                ->options(['push' => 'Push', 'pull' => 'Pull'])
                ->helperText('Push writes into this project; pull reads out of it.')
                ->required(),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table->columns([
            TextColumn::make('name')->searchable()->sortable(),
            TextColumn::make('description'),
            TextColumn::make('permissions')->badge(),
            TextColumn::make('created_at')->dateTime()->sortable(),
            TextColumn::make('last_used_at')->dateTime()->placeholder('Never'),
            TextColumn::make('expires_at')->dateTime()->placeholder('Unlimited'),
        ])->defaultSort('name');
    }

    public static function canViewAny(): bool
    {
        return auth()->user()?->can('user.update') ?? false;
    }

    public static function canCreate(): bool
    {
        return static::canViewAny();
    }

    public static function canEdit(Model $record): bool
    {
        return static::canViewAny();
    }

    public static function canDelete(Model $record): bool
    {
        return static::canViewAny();
    }

    public static function getPages(): array
    {
        return [
            'index' => ListTransferTokens::route('/'),
            'create' => CreateTransferToken::route('/create'),
            'edit' => EditTransferToken::route('/{record}/edit'),
        ];
    }
}
`,
  },
  {
    path: "app/Filament/Resources/TransferTokens/Pages/ListTransferTokens.php",
    content: page("ListTransferTokens", "ListRecords", [], ""),
  },
  {
    path: "app/Filament/Resources/TransferTokens/Pages/CreateTransferToken.php",
    content: page(
      "CreateTransferToken",
      "CreateRecord",
      [
        "App\\Support\\StrapiTransferTokens",
        "Filament\\Notifications\\Notification",
        "Illuminate\\Database\\Eloquent\\Model",
      ],
      `

    protected function handleRecordCreation(array $data): Model
    {
        // The duration select hands its option back as a string.
        $made = StrapiTransferTokens::create([...$data, 'lifespan' => filled($data['lifespan'] ?? null) ? (int) $data['lifespan'] : null]);
        $this->showKey($made['accessKey']);

        return $made['token'];
    }

    protected function getRedirectUrl(): string
    {
        return $this->getResource()::getUrl('edit', ['record' => $this->getRecord()]);
    }
${showKey}`,
    ),
  },
  {
    path: "app/Filament/Resources/TransferTokens/Pages/EditTransferToken.php",
    content: page(
      "EditTransferToken",
      "EditRecord",
      [
        "App\\Support\\StrapiTransferTokens",
        "Filament\\Actions\\Action",
        "Filament\\Actions\\DeleteAction",
        "Filament\\Notifications\\Notification",
      ],
      `

    protected function getHeaderActions(): array
    {
        return [
            Action::make('regenerate')
                ->requiresConfirmation()
                ->modalDescription('Transfers sent with the current key will be refused.')
                ->action(fn () => $this->showKey(StrapiTransferTokens::regenerate($this->record))),
            DeleteAction::make(),
        ];
    }

    protected function mutateFormDataBeforeSave(array $data): array
    {
        return [...$data, 'description' => $data['description'] ?? '', 'permissions' => StrapiTransferTokens::permissions($data['permissions'])];
    }
${showKey}`,
    ),
  },
];
