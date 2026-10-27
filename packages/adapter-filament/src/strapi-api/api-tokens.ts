import { PHP_MARKER } from "../hooks/names";
import { navigationProperties, SETTINGS } from "./admin-navigation";

/**
 * Strapi 5's content API tokens (the admin's API Tokens settings and its `content-api-token`
 * strategy): a read-only, full-access or custom token stands in for a role on every API route, is
 * kept as a salted hash, and may expire. Strapi tries a token before a session, and verifies it
 * against the route's action alone, so a token reads every row a route lists and acts for no user.
 */

export const API_TOKENS_MIGRATION_PATH =
  "database/migrations/0001_01_02_000005_create_strapi_api_tokens_table.php";

/** A content type's API controller and the uid its actions are named under (`api::book.book`). */
export interface TokenContentType {
  controller: string;
  model: string;
  uid: string;
  /** A single type, whose actions are find, update and delete. */
  single: boolean;
}

export interface ApiTokensInput {
  contentTypes: TokenContentType[];
  /** The media library's file model, when the project keeps one. */
  fileModel: string | undefined;
  localized: boolean;
}

/** Strapi's own key: a project moving off Strapi keeps its salt, and so its tokens' hashes. */
export const apiTokensConfigKeys = (): string => `

    // The salt of every API token's hash (Strapi's admin.apiToken.salt); unset, the app key.
    'api_tokens' => [
        'salt' => env('API_TOKEN_SALT'),
    ],`;

export const emitApiTokensMigration = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('strapi_api_tokens', function (Blueprint $table): void {
            $table->id();
            $table->string('name')->unique();
            $table->string('description')->default('');
            $table->string('type', 16)->default('read-only');
            $table->string('access_key', 128)->unique();
            $table->text('encrypted_key')->nullable();
            $table->json('permissions')->nullable();
            $table->dateTime('last_used_at')->nullable();
            $table->dateTime('expires_at')->nullable();
            $table->unsignedBigInteger('lifespan')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('strapi_api_tokens');
    }
};
`;

export const emitApiTokenModel = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

/** A content API token; its key is kept only as a hash and, for the admin to show again, encrypted. */
final class StrapiApiToken extends Model
{
    protected $table = 'strapi_api_tokens';

    protected $fillable = ['name', 'description', 'type', 'permissions'];

    protected $hidden = ['access_key', 'encrypted_key'];

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

const USERS_PERMISSIONS = "plugin::users-permissions";

/** Each plugin route's action, by the generated controller and method that serve it. */
const pluginRoutes = (input: ApiTokensInput): [string, [string, string][]][] => [
  [
    "AuthController",
    [
      ["register", `${USERS_PERMISSIONS}.auth.register`],
      ["login", `${USERS_PERMISSIONS}.auth.callback`],
      ["changePassword", `${USERS_PERMISSIONS}.auth.changePassword`],
      ["forgotPassword", `${USERS_PERMISSIONS}.auth.forgotPassword`],
      ["resetPassword", `${USERS_PERMISSIONS}.auth.resetPassword`],
      ["emailConfirmation", `${USERS_PERMISSIONS}.auth.emailConfirmation`],
      ["sendEmailConfirmation", `${USERS_PERMISSIONS}.auth.sendEmailConfirmation`],
    ],
  ],
  [
    "ConnectController",
    [
      ["connect", `${USERS_PERMISSIONS}.auth.connect`],
      ["callback", `${USERS_PERMISSIONS}.auth.connect`],
      ["signIn", `${USERS_PERMISSIONS}.auth.callback`],
    ],
  ],
  [
    "SessionController",
    [
      ["refresh", `${USERS_PERMISSIONS}.auth.refresh`],
      ["logout", `${USERS_PERMISSIONS}.auth.logout`],
      ["sessions", `${USERS_PERMISSIONS}.auth.getSessions`],
      ["revoke", `${USERS_PERMISSIONS}.auth.revokeSession`],
    ],
  ],
  [
    "UserController",
    [
      ["count", `${USERS_PERMISSIONS}.user.count`],
      ["find", `${USERS_PERMISSIONS}.user.find`],
      ["me", `${USERS_PERMISSIONS}.user.me`],
      ["findOne", `${USERS_PERMISSIONS}.user.findOne`],
      ["create", `${USERS_PERMISSIONS}.user.create`],
      ["update", `${USERS_PERMISSIONS}.user.update`],
      ["destroy", `${USERS_PERMISSIONS}.user.destroy`],
    ],
  ],
  ...(input.fileModel === undefined
    ? []
    : ([
        [
          "UploadController",
          [
            ["upload", "plugin::upload.content-api.upload"],
            ["find", "plugin::upload.content-api.find"],
            ["findOne", "plugin::upload.content-api.findOne"],
            ["destroy", "plugin::upload.content-api.destroy"],
          ],
        ],
      ] as [string, [string, string][]][])),
  ...(input.localized
    ? ([["LocaleController", [["index", "plugin::i18n.locales.listLocales"]]]] as [
        string,
        [string, string][],
      ][])
    : []),
];

const controllerClass = (name: string): string => `'App\\Http\\Controllers\\Api\\${name}'`;

export const emitStrapiApiTokens = (input: ApiTokensInput): string => {
  const contentTypes = [...input.contentTypes].sort((a, b) =>
    a.controller.localeCompare(b.controller),
  );
  const content = contentTypes
    .map((ct) => `        ${controllerClass(ct.controller)} => '${ct.uid}',`)
    .join("\n");
  const singles = contentTypes
    .filter((ct) => ct.single)
    .map((ct) => `'${ct.uid}'`)
    .sort()
    .join(", ");
  const routes = pluginRoutes(input)
    .map(
      ([controller, methods]) =>
        `        ${controllerClass(controller)} => [\n${methods
          .map(([method, action]) => `            '${method}' => '${action}',`)
          .join("\n")}\n        ],`,
    )
    .join("\n");
  const models = [
    ...contentTypes.map((ct) => [ct.model, ct.uid]),
    ["User", `${USERS_PERMISSIONS}.user`],
    ...(input.fileModel === undefined ? [] : [[input.fileModel, "plugin::upload.content-api"]]),
  ]
    .sort(([a], [b]) => a!.localeCompare(b!))
    .map(([model, uid]) => `        \\App\\Models\\${model}::class => '${uid}',`)
    .join("\n");
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

use App\\Models\\StrapiApiToken;
use App\\Models\\User;
use Illuminate\\Contracts\\Encryption\\DecryptException;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Crypt;
use Illuminate\\Support\\Facades\\Gate;
use InvalidArgumentException;

/**
 * Strapi's content API tokens (admin's api-token service and content-api-token strategy). A token
 * request is checked against its route's action as Strapi names it (\`api::book.book.find\`), and
 * then decides every grant the request asks for in place of a role: its own route's type is the
 * one it was checked for, and a type it reaches through a relation needs that type's find.
 */
final class StrapiApiTokens
{
    public const TYPES = ['read-only', 'full-access', 'custom'];

    /** The lifespans the admin offers, in milliseconds as Strapi keeps them; none never expires. */
    public const LIFESPANS = [7 * 86400000, 30 * 86400000, 90 * 86400000];

    private const ATTRIBUTE = 'strapi.api_token';

    /** A content type's API controller → the uid its actions are named under. */
    private const CONTENT_TYPES = [
${content}
    ];

    private const CONTENT_ACTIONS = ['index' => 'find', 'show' => 'findOne', 'store' => 'create', 'update' => 'update', 'destroy' => 'delete', 'single' => 'find', 'putSingle' => 'update', 'destroySingle' => 'delete'];

    /** The single types, which have no findOne or create. */
    private const SINGLE_TYPES = [${singles}];

    /** A plugin's controller → each method's action. */
    private const ROUTES = [
${routes}
    ];

    /** A model → the uid a token's grants on it are named under. */
    private const MODELS = [
${models}
    ];

    /**
     * @param array{name: string, description?: string|null, type?: string, lifespan?: int|null, permissions?: list<string>|null} $attributes
     * @return array{token: StrapiApiToken, accessKey: string}
     */
    public static function create(array $attributes): array
    {
        $type = $attributes['type'] ?? 'read-only';
        $lifespan = $attributes['lifespan'] ?? null;
        $permissions = array_values(array_unique($attributes['permissions'] ?? []));
        if (! in_array($type, self::TYPES, true)) {
            throw new InvalidArgumentException("Unknown API token type \\"{$type}\\"");
        }
        if ($lifespan !== null && ! in_array($lifespan, self::LIFESPANS, true)) {
            throw new InvalidArgumentException("lifespan must be one of 7, 30 or 90 days, or none");
        }
        if ($type === 'custom' && $permissions === []) {
            throw new InvalidArgumentException('A custom API token needs at least one permission');
        }
        $key = self::newKey();
        $token = new StrapiApiToken();
        $token->forceFill([
            'name' => $attributes['name'],
            'description' => $attributes['description'] ?? '',
            'type' => $type,
            'permissions' => $type === 'custom' ? $permissions : null,
            'lifespan' => $lifespan,
            'expires_at' => $lifespan === null ? null : now()->addMilliseconds($lifespan),
        ] + self::keyed($key))->save();

        return ['token' => $token, 'accessKey' => $key];
    }

    /** A new key for the token; the old one stops verifying at once. */
    public static function regenerate(StrapiApiToken $token): string
    {
        $key = self::newKey();
        $token->forceFill(self::keyed($key))->save();

        return $key;
    }

    /** The token's key, for the admin to copy again; null once the app key it was encrypted with changed. */
    public static function reveal(StrapiApiToken $token): ?string
    {
        try {
            return $token->encrypted_key === null ? null : Crypt::decryptString($token->encrypted_key);
        } catch (DecryptException) {
            return null;
        }
    }

    public static function hash(string $key): string
    {
        return hash_hmac('sha512', $key, (string) (config('camis.api_tokens.salt') ?: config('app.key')));
    }

    /** The request's API token, refusing an expired one; null when it presents none. */
    public static function authenticate(Request $request): ?StrapiApiToken
    {
        $key = $request->bearerToken();
        // A session's token is Sanctum's "<id>|<secret>", which no API token key is.
        if ($key === null || str_contains($key, '|')) {
            return null;
        }
        $token = StrapiApiToken::query()->where('access_key', self::hash($key))->first();
        if ($token === null) {
            return null;
        }
        if ($token->expires_at !== null && $token->expires_at->isPast()) {
            throw new StrapiError(401, 'UnauthorizedError', 'Token expired');
        }
        // Strapi records a use at most hourly, so a busy token is not a write per request.
        if ($token->last_used_at === null || $token->last_used_at->lte(now()->subHour())) {
            $token->forceFill(['last_used_at' => now()])->saveQuietly();
        }

        return $token;
    }

    /** The route's action as Strapi names it; null for a route Strapi does not have (api-custom.php). */
    public static function action(Request $request): ?string
    {
        [$controller, $method] = array_pad(explode('@', (string) $request->route()?->getActionName(), 2), 2, '__invoke');

        return self::actionOf($controller, $method);
    }

    /** A controller method's action as Strapi names it, for a request that runs it in-process (GraphQL). */
    public static function actionOf(string $controller, string $method): ?string
    {
        if (isset(self::CONTENT_TYPES[$controller])) {
            $action = self::CONTENT_ACTIONS[$method] ?? null;

            return $action === null ? null : self::CONTENT_TYPES[$controller].'.'.$action;
        }

        return self::ROUTES[$controller][$method] ?? null;
    }

    /** Strapi's verify: full access, reads only, or the actions a custom token was given. */
    public static function allows(StrapiApiToken $token, ?string $action): bool
    {
        return match ($token->type) {
            'full-access' => true,
            'read-only' => $action !== null && (str_ends_with($action, '.find') || str_ends_with($action, '.findOne')),
            'custom' => $action !== null && in_array($action, $token->permissions ?? [], true),
            default => false,
        };
    }

    /** The token answers every grant the request asks for, with no user and so no row condition. */
    public static function actFor(Request $request, StrapiApiToken $token, ?string $action): void
    {
        $request->attributes->set(self::ATTRIBUTE, [$token, $action === null ? null : substr($action, 0, (int) strrpos($action, '.'))]);
        // Once per application: the callback reads whichever request is current.
        if (! app()->bound(self::ATTRIBUTE)) {
            app()->instance(self::ATTRIBUTE, true);
            Gate::before(static fn (?User $user, string $ability, array $arguments): ?bool => self::decide($ability, $arguments[0] ?? null));
        }
    }

    /** Its own route's type is the one the token was checked for; another type needs that type's find. */
    private static function decide(string $ability, mixed $subject): ?bool
    {
        [$token, $own] = request()->attributes->get(self::ATTRIBUTE) ?? [null, null];
        $uid = self::MODELS[is_object($subject) ? $subject::class : (is_string($subject) ? $subject : '')] ?? null;
        if ($token === null || $uid === null) {
            return null;
        }
        if ($uid === $own) {
            return true;
        }

        return in_array($ability, ['viewAny', 'view'], true) && self::allows($token, $uid.'.find');
    }

    public static function active(): bool
    {
        return request()->attributes->has(self::ATTRIBUTE);
    }

    /** The token the current request acts for, if any. */
    public static function current(): ?StrapiApiToken
    {
        return (request()->attributes->get(self::ATTRIBUTE) ?? [null])[0];
    }

    /** @return array<string, string> Every action a custom token can be given, as the API Tokens page lists them. */
    public static function actions(): array
    {
        $actions = [];
        foreach (self::CONTENT_TYPES as $uid) {
            foreach (array_unique(self::CONTENT_ACTIONS) as $action) {
                if (! in_array($uid, self::SINGLE_TYPES, true) || ! in_array($action, ['findOne', 'create'], true)) {
                    $actions[] = $uid.'.'.$action;
                }
            }
        }
        foreach (self::ROUTES as $methods) {
            array_push($actions, ...array_values($methods));
        }
        $actions = array_values(array_unique($actions));

        return array_combine($actions, array_map(self::label(...), $actions));
    }

    /** \`api::book.book.findOne\` reads "book: findOne", \`plugin::upload.content-api.find\` "upload.content-api: find". */
    private static function label(string $action): string
    {
        $name = substr($action, (int) strpos($action, '::') + 2);
        $at = (int) strrpos($name, '.');
        [$first, $rest] = array_pad(explode('.', substr($name, 0, $at), 2), 2, null);

        return ($rest === $first ? $first : substr($name, 0, $at)).': '.substr($name, $at + 1);
    }

    private static function newKey(): string
    {
        return bin2hex(random_bytes(128));
    }

    /** @return array{access_key: string, encrypted_key: string} */
    private static function keyed(string $key): array
    {
        return ['access_key' => self::hash($key), 'encrypted_key' => Crypt::encryptString($key)];
    }
}
`;
};

export const emitStrapiApiTokenMiddleware = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Middleware;

use App\\Support\\StrapiApiTokens;
use App\\Support\\StrapiError;
use Closure;
use Illuminate\\Http\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

/**
 * Strapi's first content API strategy: an API token, checked against the route's action. A
 * GraphQL request runs many actions, so StrapiGraphql checks the token against each one it runs.
 */
final class StrapiApiToken
{
    public function handle(Request $request, Closure $next): Response
    {
        $token = StrapiApiTokens::authenticate($request);
        if ($token !== null && explode('@', (string) $request->route()?->getActionName())[0] === 'App\\GraphQL\\StrapiGraphql') {
            StrapiApiTokens::actFor($request, $token, null);
        } elseif ($token !== null) {
            $action = StrapiApiTokens::action($request);
            if (! StrapiApiTokens::allows($token, $action)) {
                throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
            }
            StrapiApiTokens::actFor($request, $token, $action);
        }

        return $next($request);
    }
}
`;

const page = (cls: string, base: string, uses: string[], body: string): string => `<?php

declare(strict_types=1);

namespace App\\Filament\\Resources\\ApiTokens\\Pages;

${[
  "App\\Filament\\Resources\\ApiTokens\\ApiTokenResource",
  `Filament\\Resources\\Pages\\${base}`,
  ...uses,
]
  .sort()
  .map((u) => `use ${u};`)
  .join("\n")}

class ${cls} extends ${base}
{
    protected static string $resource = ApiTokenResource::class;${body}
}
`;

// The key is shown once it exists and whenever it is regenerated, as Strapi's page shows it.
const showKey = `
    private function showKey(string $key): void
    {
        Notification::make()->success()->persistent()
            ->title('Copy your API token')
            ->body($key)
            ->send();
    }`;

/**
 * The admin's API Tokens settings (Strapi's Settings › API Tokens), for whoever may change accounts:
 * a token can read and write any content, as an administrator can.
 */
export const emitApiTokenResourceFiles = (): { path: string; content: string }[] => [
  {
    path: "app/Filament/Resources/ApiTokens/ApiTokenResource.php",
    content: `<?php

declare(strict_types=1);

namespace App\\Filament\\Resources\\ApiTokens;

use App\\Filament\\Resources\\ApiTokens\\Pages\\CreateApiToken;
use App\\Filament\\Resources\\ApiTokens\\Pages\\EditApiToken;
use App\\Filament\\Resources\\ApiTokens\\Pages\\ListApiTokens;
use App\\Filament\\StrapiNavigation;
use App\\Models\\StrapiApiToken;
use App\\Support\\StrapiApiTokens;
use BackedEnum;
use Filament\\Forms\\Components\\CheckboxList;
use Filament\\Forms\\Components\\Select;
use Filament\\Forms\\Components\\TextInput;
use Filament\\Resources\\Resource;
use Filament\\Schemas\\Components\\Utilities\\Get;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Columns\\TextColumn;
use Filament\\Tables\\Table;
use Illuminate\\Database\\Eloquent\\Model;
use UnitEnum;

class ApiTokenResource extends Resource
{
    protected static ?string $model = StrapiApiToken::class;

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-key';
${navigationProperties(SETTINGS.apiTokens)}
    protected static ?string $modelLabel = 'API token';

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('name')->required()->unique(ignoreRecord: true),
            TextInput::make('description'),
            Select::make('lifespan')->label('Token duration')
                ->options([604800000 => '7 days', 2592000000 => '30 days', 7776000000 => '90 days'])
                ->placeholder('Unlimited')
                ->visibleOn('create'),
            Select::make('type')->label('Token type')
                ->options(['read-only' => 'Read-only', 'full-access' => 'Full access', 'custom' => 'Custom'])
                ->default('read-only')->required()->live(),
            CheckboxList::make('permissions')
                ->options(StrapiApiTokens::actions())
                ->columns(3)
                ->visible(fn (Get $get): bool => $get('type') === 'custom')
                ->required(fn (Get $get): bool => $get('type') === 'custom'),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table->columns([
            TextColumn::make('name')->searchable()->sortable(),
            TextColumn::make('description'),
            TextColumn::make('type'),
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
            'index' => ListApiTokens::route('/'),
            'create' => CreateApiToken::route('/create'),
            'edit' => EditApiToken::route('/{record}/edit'),
        ];
    }
}
`,
  },
  {
    path: "app/Filament/Resources/ApiTokens/Pages/ListApiTokens.php",
    content: page("ListApiTokens", "ListRecords", [], ""),
  },
  {
    path: "app/Filament/Resources/ApiTokens/Pages/CreateApiToken.php",
    content: page(
      "CreateApiToken",
      "CreateRecord",
      [
        "App\\Support\\StrapiApiTokens",
        "Filament\\Notifications\\Notification",
        "Illuminate\\Database\\Eloquent\\Model",
      ],
      `

    protected function handleRecordCreation(array $data): Model
    {
        // The duration select hands its option back as a string.
        $made = StrapiApiTokens::create([...$data, 'lifespan' => filled($data['lifespan'] ?? null) ? (int) $data['lifespan'] : null]);
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
    path: "app/Filament/Resources/ApiTokens/Pages/EditApiToken.php",
    content: page(
      "EditApiToken",
      "EditRecord",
      [
        "App\\Support\\StrapiApiTokens",
        "Filament\\Actions\\Action",
        "Filament\\Actions\\DeleteAction",
        "Filament\\Notifications\\Notification",
      ],
      `

    protected function getHeaderActions(): array
    {
        return [
            Action::make('view')->label('View token')
                ->visible(fn (): bool => $this->record->encrypted_key !== null)
                ->action(fn () => $this->showKey(StrapiApiTokens::reveal($this->record) ?? 'This token can no longer be shown: regenerate it.')),
            Action::make('regenerate')
                ->requiresConfirmation()
                ->modalDescription('Requests sent with the current key will be refused.')
                ->action(fn () => $this->showKey(StrapiApiTokens::regenerate($this->record))),
            DeleteAction::make(),
        ];
    }

    /** A token that is no longer custom keeps no actions, as Strapi drops them. */
    protected function mutateFormDataBeforeSave(array $data): array
    {
        return $data['type'] === 'custom' ? $data : [...$data, 'permissions' => null];
    }
${showKey}`,
    ),
  },
];
