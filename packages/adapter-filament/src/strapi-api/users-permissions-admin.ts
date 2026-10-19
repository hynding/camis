/**
 * The admin side of users-permissions in Filament: the Users resource (Strapi's content-manager
 * view of the user type) and the Users & Permissions settings page (its advanced settings and
 * email templates).
 */

const page = (cls: string, base: string, uses: string[], body: string): string => `<?php

declare(strict_types=1);

namespace App\\Filament\\Resources\\Users\\Pages;

${["App\\Filament\\Resources\\Users\\UserResource", `Filament\\Resources\\Pages\\${base}`, ...uses]
  .sort()
  .map((u) => `use ${u};`)
  .join("\n")}

class ${cls} extends ${base}
{
    protected static string $resource = UserResource::class;${body}
}
`;

// The users table's own columns, which the host's User model does not list as fillable.
const ACCOUNT_KEYS = "['username', 'email', 'password', 'confirmed', 'blocked']";

export const emitUserResourceFiles = (secured: boolean): { path: string; content: string }[] => [
  {
    path: "app/Filament/Resources/Users/UserResource.php",
    content: `<?php

declare(strict_types=1);

namespace App\\Filament\\Resources\\Users;

use App\\Filament\\Resources\\Users\\Pages\\CreateUser;
use App\\Filament\\Resources\\Users\\Pages\\EditUser;
use App\\Filament\\Resources\\Users\\Pages\\ListUsers;
use App\\Models\\User;
use BackedEnum;
use Filament\\Forms\\Components\\Select;
use Filament\\Forms\\Components\\TextInput;
use Filament\\Forms\\Components\\Toggle;
use Filament\\Resources\\Resource;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Columns\\IconColumn;
use Filament\\Tables\\Columns\\TextColumn;
use Filament\\Tables\\Table;${secured ? "\nuse Illuminate\\Database\\Eloquent\\Model;" : ""}
use Illuminate\\Support\\Facades\\Hash;

class UserResource extends Resource
{
    protected static ?string $model = User::class;

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-users';

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('username')->required()->unique(ignoreRecord: true),
            TextInput::make('email')->email()->required()->unique(ignoreRecord: true),
            TextInput::make('password')->password()->revealable()
                ->required(fn (string $operation): bool => $operation === 'create')
                ->dehydrated(fn (?string $state): bool => filled($state))
                ->dehydrateStateUsing(fn (string $state): string => Hash::make($state)),
            Toggle::make('confirmed'),
            Toggle::make('blocked'),${
              secured
                ? `
            Select::make('roles')->relationship('roles', 'name')->multiple()->preload(),`
                : ""
            }
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table->columns([
            TextColumn::make('username')->searchable()->sortable(),
            TextColumn::make('email')->searchable()->sortable(),
            IconColumn::make('confirmed')->boolean(),
            IconColumn::make('blocked')->boolean(),
            TextColumn::make('created_at')->dateTime()->sortable(),
        ])->defaultSort('username');
    }

${
  secured
    ? `    // The builtin user's grants, whether or not a policy for it was generated.
    public static function canViewAny(): bool
    {
        return auth()->user()?->can('user.read') ?? false;
    }

    public static function canCreate(): bool
    {
        return auth()->user()?->can('user.create') ?? false;
    }

    public static function canEdit(Model $record): bool
    {
        return auth()->user()?->can('user.update') ?? false;
    }

    public static function canDelete(Model $record): bool
    {
        return auth()->user()?->can('user.delete') ?? false;
    }

`
    : ""
}    public static function getPages(): array
    {
        return [
            'index' => ListUsers::route('/'),
            'create' => CreateUser::route('/create'),
            'edit' => EditUser::route('/{record}/edit'),
        ];
    }
}
`,
  },
  {
    path: "app/Filament/Resources/Users/Pages/ListUsers.php",
    content: page("ListUsers", "ListRecords", [], ""),
  },
  {
    path: "app/Filament/Resources/Users/Pages/CreateUser.php",
    content: page(
      "CreateUser",
      "CreateRecord",
      ["App\\Support\\StrapiUsers", "Illuminate\\Database\\Eloquent\\Model"],
      `

    /** An account made here is a local one, as one registered through the API is. */
    protected function handleRecordCreation(array $data): Model
    {
        return StrapiUsers::add($data);
    }`,
    ),
  },
  {
    path: "app/Filament/Resources/Users/Pages/EditUser.php",
    content: page(
      "EditUser",
      "EditRecord",
      ["Illuminate\\Database\\Eloquent\\Model"],
      `

    protected function handleRecordUpdate(Model $record, array $data): Model
    {
        if (isset($data['email'])) {
            $data['email'] = mb_strtolower((string) $data['email']);
        }
        $record->forceFill(array_intersect_key($data, array_flip(${ACCOUNT_KEYS})))->save();

        return $record;
    }`,
    ),
  },
];

const emailTemplate = (key: string, title: string): string => `
            Section::make('${title}')->statePath('email.${key}')->collapsed()->schema([
                TextInput::make('from.name')->label('Shipper name'),
                TextInput::make('from.email')->label('Shipper email')->email(),
                TextInput::make('response_email')->label('Response email')->email(),
                TextInput::make('object')->label('Subject')->required(),
                Textarea::make('message')->rows(8)->required(),
            ]),`;

/**
 * Strapi keeps these settings in its store and edits them in its admin, so they change without a
 * redeploy. Only someone who may update users may change how accounts are made.
 */
export const emitUsersPermissionsSettingsPage = (secured: boolean): string => `<?php

declare(strict_types=1);

namespace App\\Filament\\Pages;

use App\\Support\\StrapiSettings;
use App\\Support\\StrapiUsers;
use BackedEnum;
use Filament\\Actions\\Action;
use Filament\\Forms\\Components\\Textarea;
use Filament\\Forms\\Components\\TextInput;
use Filament\\Forms\\Components\\Toggle;
use Filament\\Notifications\\Notification;
use Filament\\Pages\\Page;
use Filament\\Schemas\\Components\\Actions;
use Filament\\Schemas\\Components\\EmbeddedSchema;
use Filament\\Schemas\\Components\\Form;
use Filament\\Schemas\\Components\\Section;
use Filament\\Schemas\\Schema;
use UnitEnum;

class UsersPermissionsSettings extends Page
{
    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-cog-6-tooth';

    protected static string | UnitEnum | null $navigationGroup = 'Settings';

    protected static ?string $navigationLabel = 'Users & Permissions';

    protected static ?string $title = 'Users & Permissions';

    public ?array $data = [];

    public static function canAccess(): bool
    {
        return ${secured ? "auth()->user()?->can('user.update') ?? false" : "true"};
    }

    public function mount(): void
    {
        $this->form->fill(['advanced' => StrapiUsers::advanced(), 'email' => StrapiUsers::emails()]);
    }

    public function form(Schema $schema): Schema
    {
        return $schema->components([
            Section::make('Advanced settings')->statePath('advanced')->schema([
                Toggle::make('allow_register')->label('Enable sign-ups'),
                Toggle::make('email_confirmation')->label('Enable email confirmation'),
                Toggle::make('unique_email')->label('One account per email address'),
                TextInput::make('email_confirmation_redirection')->label('Redirection url')->url(),
                TextInput::make('email_reset_password')->label('Reset password page')->url(),
            ]),${emailTemplate("email_confirmation", "Email address confirmation")}${emailTemplate("reset_password", "Reset password")}
        ])->statePath('data');
    }

    public function content(Schema $schema): Schema
    {
        return $schema->components([
            Form::make([EmbeddedSchema::make('form')])
                ->id('form')
                ->livewireSubmitHandler('save')
                ->footer([Actions::make([Action::make('save')->submit('save')])]),
        ]);
    }

    public function save(): void
    {
        $state = $this->form->getState();
        StrapiSettings::merge('users-permissions.advanced', $state['advanced']);
        StrapiSettings::merge('users-permissions.email', $state['email']);
        Notification::make()->success()->title('Saved')->send();
    }
}
`;
