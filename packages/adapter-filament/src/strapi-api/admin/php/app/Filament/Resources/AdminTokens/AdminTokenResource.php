<?php

declare(strict_types=1);

namespace App\Filament\Resources\AdminTokens;

use App\Filament\Resources\AdminTokens\Pages\CreateAdminToken;
use App\Filament\Resources\AdminTokens\Pages\EditAdminToken;
use App\Filament\Resources\AdminTokens\Pages\ListAdminTokens;
use App\Filament\StrapiNavigation;
use App\Models\AdminUser;
use App\Models\StrapiAdminToken;
use App\Support\StrapiAdminTokens;
use BackedEnum;
use Closure;
use Filament\Forms\Components\CheckboxList;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Resources\Resource;
use Filament\Schemas\Schema;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;
use Illuminate\Auth\Access\Response;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use UnitEnum;

/**
 * Strapi's Settings › Admin Tokens: tokens that act in the admin as the account that made them,
 * given only permissions that account holds. An account sees its own, a super-admin every one.
 */
class AdminTokenResource extends Resource
{
    protected static ?string $model = StrapiAdminToken::class;

    // Strapi's own path for the page, which leaves /admin/admin-tokens to its admin API.
    protected static ?string $slug = 'settings/admin-tokens';

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-key';

    protected static string | UnitEnum | null $navigationGroup = StrapiNavigation::Settings;

    protected static ?string $navigationLabel = 'Admin Tokens';

    // Strapi's Administration Panel: Roles, Users, then Admin Tokens.
    protected static ?int $navigationSort = 53;

    protected static ?string $modelLabel = 'admin token';

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('name')->required()->maxLength(255)->unique('strapi_api_tokens', 'name', ignoreRecord: true),
            TextInput::make('description'),
            Select::make('lifespan')->label('Token duration')
                ->options([604800000 => '7 days', 2592000000 => '30 days', 7776000000 => '90 days'])
                ->placeholder('Unlimited')
                ->visibleOn('create'),
            CheckboxList::make('admin_permissions')->label('Permissions')
                ->helperText('A token may do only what its owner may.')
                ->options(fn (?StrapiAdminToken $record): array => self::options(self::owner($record)))
                ->rule(fn (?StrapiAdminToken $record): Closure => function (string $attribute, mixed $value, Closure $fail) use ($record): void {
                    $offered = array_keys(self::options(self::owner($record)));
                    foreach (is_array($value) ? $value : [] as $permission) {
                        if (! in_array($permission, $offered, true)) {
                            $fail("The token's owner does not hold {$permission}.");
                        }
                    }
                })
                ->columns(5)
                ->bulkToggleable(),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table->columns([
            TextColumn::make('name')->searchable()->sortable(),
            TextColumn::make('description'),
            TextColumn::make('created_at')->label('Created at')->dateTime(),
            TextColumn::make('last_used_at')->label('Last used')->dateTime()->placeholder('Never'),
            TextColumn::make('owner.email')->label('Owner'),
        ])->defaultSort('name');
    }

    /** An account's own tokens; a super-admin's, every account's. */
    public static function getEloquentQuery(): Builder
    {
        $query = parent::getEloquentQuery()->with('owner');
        $admin = auth()->user();

        return $admin instanceof AdminUser && StrapiAdminTokens::isSuperAdmin($admin)
            ? $query
            : $query->where('admin_user_owner_id', $admin?->getKey());
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
            'index' => ListAdminTokens::route('/'),
            'create' => CreateAdminToken::route('/create'),
            'edit' => EditAdminToken::route('/{record}/edit'),
        ];
    }

    /** A new token's owner is whoever makes it. */
    private static function owner(?StrapiAdminToken $record): ?AdminUser
    {
        $owner = $record->owner ?? auth()->user();

        return $owner instanceof AdminUser ? $owner : null;
    }

    /** @return array<string, string> each permission the owner holds, labelled "Section · Action" */
    private static function options(?AdminUser $owner): array
    {
        $options = [];
        foreach ($owner === null ? [] : StrapiAdminTokens::offered($owner) as $section => $permissions) {
            foreach ($permissions as $permission => $action) {
                $options[$permission] = "{$section} · {$action}";
            }
        }

        return $options;
    }
}
