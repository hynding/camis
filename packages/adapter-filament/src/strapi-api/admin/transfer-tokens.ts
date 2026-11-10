import type { CapabilityGap } from "@camis/ir-schema";
import { navigationProperties, SETTINGS } from "./admin-navigation";
import { runtimePhp } from "../../runtime-php";

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

export const emitTransferTokensMigration = (): string =>
  runtimePhp(
    new URL(
      "./php/database/migrations/0001_01_02_000007_create_strapi_transfer_tokens_table.php",
      import.meta.url,
    ),
  );

export const emitTransferTokenModel = (): string =>
  runtimePhp(new URL("./php/app/Models/StrapiTransferToken.php", import.meta.url));

export const emitStrapiTransferTokens = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiTransferTokens.php", import.meta.url));

export const emitStrapiTransferRunner = (): string =>
  runtimePhp(new URL("./php/app/Http/Controllers/Admin/StrapiTransferRunner.php", import.meta.url));

/** Strapi's transfer runner when tokens are kept, and the Data transfer page's download link. */
export const emitTransferRoutes = (secured: boolean): string => `<?php

// @camis:generated — do not edit. bootstrap/app.php loads this file (see camis scaffold).

declare(strict_types=1);

${[
  ...(secured
    ? ["App\\Http\\Controllers\\Admin\\StrapiTransferRunner", "App\\Http\\Middleware\\StrapiErrors"]
    : []),
  "App\\Http\\Controllers\\Admin\\StrapiTransferDownload",
  "Illuminate\\Support\\Facades\\Route",
]
  .sort()
  .map((u) => `use ${u};`)
  .join("\n")}
${
  secured
    ? `
// Strapi's transfer runner, beside Filament's own /admin routes; the token is its only credential.
Route::middleware([StrapiErrors::class])->group(function (): void {
    Route::get('/admin/transfer/runner/push', [StrapiTransferRunner::class, 'push']);
    Route::get('/admin/transfer/runner/pull', [StrapiTransferRunner::class, 'pull']);
});
`
    : ""
}
// An export the Data transfer page wrote; the link it signs is the only credential, for ten minutes.
Route::get('/admin/data-transfer/{file}', StrapiTransferDownload::class)
    ->middleware('signed')
    ->where('file', '[A-Za-z0-9][A-Za-z0-9_.-]*')
    ->name('camis.data-transfer.download');
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
use App\\Filament\\StrapiNavigation;
use App\\Models\\StrapiTransferToken;
use BackedEnum;
use Filament\\Forms\\Components\\CheckboxList;
use Filament\\Forms\\Components\\Select;
use Filament\\Forms\\Components\\TextInput;
use Filament\\Resources\\Resource;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Columns\\TextColumn;
use Filament\\Tables\\Table;
use Illuminate\\Auth\\Access\\Response;
use Illuminate\\Database\\Eloquent\\Model;
use UnitEnum;

class TransferTokenResource extends Resource
{
    protected static ?string $model = StrapiTransferToken::class;

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-arrows-right-left';
${navigationProperties(SETTINGS.transferTokens)}
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

    public static function getViewAnyAuthorizationResponse(): Response
    {
        return (auth()->user()?->can('user.update') ?? false) ? Response::allow() : Response::deny();
    }

    public static function getCreateAuthorizationResponse(): Response
    {
        return static::getViewAnyAuthorizationResponse();
    }

    public static function getEditAuthorizationResponse(Model $record): Response
    {
        return static::getViewAnyAuthorizationResponse();
    }

    public static function getDeleteAuthorizationResponse(Model $record): Response
    {
        return static::getViewAnyAuthorizationResponse();
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
