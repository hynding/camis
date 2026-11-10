import { navigationProperties, SETTINGS } from "./admin-navigation";

/**
 * Strapi's Settings › Administration Panel › Users: the admin's own accounts (AdminUser rows in
 * admin_users), for whoever may change accounts, as the API Tokens page. An admin account holds
 * only the IR's admin roles; the API's users keep theirs on the Users page.
 */

const page = (cls: string, base: string, uses: string[], body: string): string => `<?php

declare(strict_types=1);

namespace App\\Filament\\Resources\\AdminUsers\\Pages;

${[
  "App\\Filament\\Resources\\AdminUsers\\AdminUserResource",
  `Filament\\Resources\\Pages\\${base}`,
  ...uses,
]
  .sort()
  .map((u) => `use ${u};`)
  .join("\n")}

class ${cls} extends ${base}
{
    protected static string $resource = AdminUserResource::class;${body}
}
`;

export const emitAdminUserResourceFiles = (): { path: string; content: string }[] => [
  {
    path: "app/Filament/Resources/AdminUsers/AdminUserResource.php",
    content: `<?php

declare(strict_types=1);

namespace App\\Filament\\Resources\\AdminUsers;

use App\\Filament\\Resources\\AdminUsers\\Pages\\CreateAdminUser;
use App\\Filament\\Resources\\AdminUsers\\Pages\\EditAdminUser;
use App\\Filament\\Resources\\AdminUsers\\Pages\\ListAdminUsers;
use App\\Filament\\StrapiNavigation;
use App\\Models\\AdminUser;
use BackedEnum;
use Filament\\Forms\\Components\\Select;
use Filament\\Forms\\Components\\TextInput;
use Filament\\Forms\\Components\\Toggle;
use Filament\\Resources\\Resource;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Columns\\IconColumn;
use Filament\\Tables\\Columns\\TextColumn;
use Filament\\Tables\\Table;
use Illuminate\\Auth\\Access\\Response;
use Illuminate\\Database\\Eloquent\\Builder;
use Illuminate\\Database\\Eloquent\\Model;
use UnitEnum;

class AdminUserResource extends Resource
{
    protected static ?string $model = AdminUser::class;

    protected static ?string $slug = 'settings/users';

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-user-group';
${navigationProperties(SETTINGS.adminUsers)}
    protected static ?string $modelLabel = 'admin user';

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('firstname')->required(),
            TextInput::make('lastname'),
            TextInput::make('email')->email()->required()->unique(ignoreRecord: true)
                ->dehydrateStateUsing(fn (string $state): string => mb_strtolower($state)),
            TextInput::make('username'),
            TextInput::make('password')->password()->revealable()->minLength(8)
                ->required(fn (string $operation): bool => $operation === 'create')
                ->dehydrated(fn (?string $state): bool => filled($state)),
            Toggle::make('is_active')->label('Active')->default(true),
            Toggle::make('blocked'),
            Select::make('roles')
                ->relationship('roles', 'name', fn (Builder $query): Builder => $query->whereIn('name', AdminUser::ADMIN_ROLES))
                ->multiple()->preload(),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table->columns([
            TextColumn::make('firstname')->searchable()->sortable(),
            TextColumn::make('lastname')->searchable()->sortable(),
            TextColumn::make('email')->searchable()->sortable(),
            TextColumn::make('username')->searchable(),
            TextColumn::make('roles.name')->badge(),
            IconColumn::make('is_active')->label('Active')->boolean(),
        ])->defaultSort('firstname');
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
            'index' => ListAdminUsers::route('/'),
            'create' => CreateAdminUser::route('/create'),
            'edit' => EditAdminUser::route('/{record}/edit'),
        ];
    }
}
`,
  },
  {
    path: "app/Filament/Resources/AdminUsers/Pages/ListAdminUsers.php",
    content: page(
      "ListAdminUsers",
      "ListRecords",
      ["Filament\\Actions\\CreateAction"],
      `

    protected function getHeaderActions(): array
    {
        return [
            CreateAction::make()->label('Invite new user'),
        ];
    }`,
    ),
  },
  {
    path: "app/Filament/Resources/AdminUsers/Pages/CreateAdminUser.php",
    content: page("CreateAdminUser", "CreateRecord", [], ""),
  },
  {
    path: "app/Filament/Resources/AdminUsers/Pages/EditAdminUser.php",
    content: page(
      "EditAdminUser",
      "EditRecord",
      ["Filament\\Actions\\DeleteAction"],
      `

    protected function getHeaderActions(): array
    {
        return [
            DeleteAction::make(),
        ];
    }`,
    ),
  },
];
