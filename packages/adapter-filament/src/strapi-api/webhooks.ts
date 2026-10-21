import { PHP_MARKER } from "../hooks/names";

/**
 * Strapi 5's webhooks (the admin's Webhooks settings, and the `entry.*` and `media.*` events its
 * document service and upload plugin emit): every enabled webhook that hears an event is POSTed
 * `{ event, createdAt, ...info }`. strapi-php sends them during the request; here they are sent
 * once the response has gone (`app()->terminating`, after PHP-FPM's `fastcgi_finish_request`), so
 * a shared host needs no queue worker and a slow receiver never slows a write. An entry is sent
 * populated as Strapi populates it, whoever wrote it; a deletion as the row was.
 */

export const WEBHOOKS_MIGRATION_PATH =
  "database/migrations/0001_01_02_000006_create_strapi_webhooks_table.php";

/** A content type's model and the names Strapi sends with its entries. */
export interface WebhookContentType {
  model: string;
  uid: string;
  modelName: string;
}

export interface WebhooksInput {
  contentTypes: WebhookContentType[];
  /** The media library's file model, when the project keeps one. */
  fileModel: string | undefined;
}

/** Strapi's server.webhooks.defaultHeaders: added to every webhook's own headers. */
export const webhooksConfigKeys = (): string => `

    // Headers every webhook sends besides its own (Strapi's server.webhooks.defaultHeaders).
    'webhooks' => ['default_headers' => []],`;

/** Strapi's own table and columns, so a project moving between the runtimes keeps its webhooks. */
export const emitWebhooksMigration = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('strapi_webhooks', function (Blueprint $table): void {
            $table->id();
            $table->string('name')->nullable();
            $table->text('url')->nullable();
            $table->json('headers')->nullable();
            $table->json('events')->nullable();
            $table->boolean('enabled')->nullable();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('strapi_webhooks');
    }
};
`;

export const emitWebhookModel = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

/** A webhook: where to POST which events, with what headers. */
final class StrapiWebhook extends Model
{
    protected $table = 'strapi_webhooks';

    public $timestamps = false;

    protected $fillable = ['name', 'url', 'headers', 'events', 'enabled'];

    protected $attributes = ['enabled' => true];

    protected function casts(): array
    {
        return [
            'headers' => 'array',
            'events' => 'array',
            'enabled' => 'boolean',
        ];
    }
}
`;

/** Wires a content type's (or the media library's) own writes to its webhooks. */
export const emitEmitsStrapiEvents = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Models\\Concerns;

use App\\Support\\StrapiWebhooks;
use Illuminate\\Database\\Eloquent\\Model;

trait EmitsStrapiEvents
{
    protected static function bootEmitsStrapiEvents(): void
    {
        static::saved(fn (Model $row) => StrapiWebhooks::saved($row));
        static::deleted(fn (Model $row) => StrapiWebhooks::deleted($row));
    }
}
`;

const ENTRY_EVENTS = [
  "entry.create",
  "entry.update",
  "entry.delete",
  "entry.publish",
  "entry.unpublish",
  "entry.draft-discard",
];
const MEDIA_EVENTS = ["media.create", "media.update", "media.delete"];

export const webhookEvents = (media: boolean): string[] =>
  media ? [...ENTRY_EVENTS, ...MEDIA_EVENTS] : ENTRY_EVENTS;

export const emitStrapiWebhooks = (input: WebhooksInput): string => {
  const events = webhookEvents(input.fileModel !== undefined)
    .map((e) => `        '${e}',`)
    .join("\n");
  const contentTypes = [...input.contentTypes]
    .sort((a, b) => a.model.localeCompare(b.model))
    .map(
      (ct) =>
        `        \\App\\Models\\${ct.model}::class => ['${ct.uid}', '${ct.modelName}', \\App\\Http\\Serializers\\${ct.model}Serializer::class],`,
    )
    .join("\n");
  const file = input.fileModel === undefined ? "null" : `\\App\\Models\\${input.fileModel}::class`;
  const fileSerializer =
    input.fileModel === undefined
      ? ""
      : `
        if ($class === self::FILE) {
            return ['media' => \\App\\Http\\Serializers\\${input.fileModel}Serializer::toWire($row)];
        }`;
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

use App\\Models\\StrapiWebhook;
use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Support\\Facades\\DB;
use Illuminate\\Support\\Facades\\Http;

final class StrapiWebhooks
{
    /** Every event a webhook can hear, as the admin lists them. */
    public const EVENTS = [
${events}
    ];

    /** Each content type's model: its uid, its model name and its serializer. */
    private const CONTENT_TYPES = [
${contentTypes}
    ];

    /** The media library's file model, whose writes are media events. */
    private const FILE = ${file};

    /** Sent as the row was, since it is gone once the request is done. */
    private const AS_IT_WAS = ['entry.delete', 'entry.unpublish', 'media.delete'];

    /** The request's pending events, kept in the container so they never outlive its app. */
    private const PENDING = 'strapi.webhooks.pending';

    private static int $quiet = 0;

    /** Runs $write without its rows' own writes being events: the caller sends what Strapi sends. */
    public static function quietly(\\Closure $write): mixed
    {
        self::$quiet++;
        try {
            return $write();
        } finally {
            self::$quiet--;
        }
    }

    public static function saved(Model $row): void
    {
        self::heard($row->wasRecentlyCreated ? 'create' : 'update', $row);
    }

    public static function deleted(Model $row): void
    {
        self::heard('delete', $row);
    }

    /** Sends $event for $row once the surrounding transaction commits; nothing if it rolls back. */
    public static function entry(string $event, Model $row): void
    {
        $class = $row::class;
        $id = $row->getKey();
        $info = in_array($event, self::AS_IT_WAS, true) ? self::info($row, false) : null;
        DB::afterCommit(function () use ($event, $class, $id, $info): void {
            $pending = self::pending();
            // A row written twice in one request is one creation, or one update, as Strapi sends it.
            if (in_array(substr($event, strpos($event, '.') + 1), ['create', 'update'], true)) {
                if (isset($pending->written["{$class}#{$id}"])) {
                    return;
                }
                $pending->written["{$class}#{$id}"] = true;
            }
            $pending->events[] = [$event, $info ?? fn (): ?array => self::current($class, $id)];
        });
    }

    /** Sends what the request's writes owe their webhooks. */
    public static function flush(): void
    {
        $pending = self::pending();
        [$events, $pending->events, $pending->written] = [$pending->events, [], []];
        if ($events === []) {
            return;
        }
        $webhooks = StrapiWebhook::query()->where('enabled', true)->orderBy('id')->get();
        foreach ($events as [$event, $info]) {
            $listening = $webhooks->filter(fn (StrapiWebhook $webhook): bool => in_array($event, $webhook->events ?? [], true));
            $info = $listening->isEmpty() || is_array($info) ? $info : $info();
            if ($info === null || $listening->isEmpty()) {
                continue;
            }
            foreach ($listening as $webhook) {
                self::run($webhook, $event, $info);
            }
        }
    }

    /**
     * POSTs one event to one webhook; a failure is its answer, never an exception.
     *
     * @return array{statusCode: int, message?: string}
     */
    public static function run(StrapiWebhook $webhook, string $event, array $info = []): array
    {
        $body = ['event' => $event, 'createdAt' => now()->toIso8601ZuluString('millisecond'), ...$info];
        try {
            $response = Http::timeout(10)
                ->withHeaders([...config('camis.webhooks.default_headers', []), ...($webhook->headers ?? []), 'X-Strapi-Event' => $event])
                ->withBody((string) json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'application/json')
                ->post((string) $webhook->url);
        } catch (\\Throwable $error) {
            return ['statusCode' => 500, 'message' => $error->getMessage()];
        }

        return $response->successful()
            ? ['statusCode' => $response->status()]
            : ['statusCode' => $response->status(), 'message' => $response->body()];
    }

    /**
     * Each pending event and what it sends, and the rows whose creation or update is pending; the
     * first event of a request has them sent once its response has gone.
     *
     * @return object{events: list<array{0: string, 1: array|\\Closure(): ?array}>, written: array<string, true>}
     */
    private static function pending(): object
    {
        if (! app()->bound(self::PENDING)) {
            app()->instance(self::PENDING, (object) ['events' => [], 'written' => []]);
            app()->terminating(fn () => self::flush());
        }

        return app(self::PENDING);
    }

    private static function heard(string $action, Model $row): void
    {
        if (self::$quiet === 0) {
            self::entry(($row::class === self::FILE ? 'media.' : 'entry.').$action, $row);
        }
    }

    private static function current(string $class, mixed $id): ?array
    {
        $row = $class::query()->find($id);

        return $row === null ? null : self::info($row, true);
    }

    /**
     * What Strapi sends with an event: a file as it is, an entry with its model's names and, when
     * $populated, every relation, file and component, as Strapi's deep populate reads them.
     */
    private static function info(Model $row, bool $populated): ?array
    {
        $class = $row::class;${fileSerializer}
        if (! isset(self::CONTENT_TYPES[$class])) {
            return null;
        }
        [$uid, $modelName, $serializer] = self::CONTENT_TYPES[$class];
        $entry = $populated
            ? StrapiQuery::unrestricted(fn (): array => StrapiPopulate::one($row, [
                'populate' => '*',
                'status' => $serializer::DRAFT_PUBLISH && $row->getAttribute('published_at') === null ? 'draft' : 'published',
            ], $serializer, null))
            : array_diff_key($serializer::toWire($row), array_flip($serializer::COMPONENTS));

        return ['model' => $modelName, 'uid' => $uid, 'entry' => $entry];
    }
}
`;
};

/** Strapi's admin url check: a valid url, with a scheme, a host and an optional port and path. */
const URL_PATTERN = String.raw`/^(?:([a-z0-9+.-]+):\/\/)(?:\S+(?::\S*)?@)?(?:(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z\x{00a1}-\x{ffff}0-9_]-*)*[a-z\x{00a1}-\x{ffff}0-9_]+)(?:\.(?:[a-z\x{00a1}-\x{ffff}0-9_]-*)*[a-z\x{00a1}-\x{ffff}0-9_]+)*\.?)(?::\d{2,5})?(?:[\/?#]\S*)?$/u`;

const page = (cls: string, base: string, uses: string[], body: string): string => `<?php

declare(strict_types=1);

namespace App\\Filament\\Resources\\Webhooks\\Pages;

${[
  "App\\Filament\\Resources\\Webhooks\\WebhookResource",
  `Filament\\Resources\\Pages\\${base}`,
  ...uses,
]
  .sort()
  .map((u) => `use ${u};`)
  .join("\n")}

class ${cls} extends ${base}
{
    protected static string $resource = WebhookResource::class;${body}
}
`;

/**
 * The admin's Webhooks settings (Strapi's Settings › Webhooks). Where the project has roles, for
 * whoever may change accounts, as API tokens are: a webhook sends any entry it hears.
 */
export const emitWebhookResourceFiles = (secured: boolean): { path: string; content: string }[] => [
  {
    path: "app/Filament/Resources/Webhooks/WebhookResource.php",
    content: `<?php

declare(strict_types=1);

namespace App\\Filament\\Resources\\Webhooks;

use App\\Filament\\Resources\\Webhooks\\Pages\\CreateWebhook;
use App\\Filament\\Resources\\Webhooks\\Pages\\EditWebhook;
use App\\Filament\\Resources\\Webhooks\\Pages\\ListWebhooks;
use App\\Models\\StrapiWebhook;
use App\\Support\\StrapiWebhooks;
use BackedEnum;
use Closure;
use Filament\\Forms\\Components\\CheckboxList;
use Filament\\Forms\\Components\\KeyValue;
use Filament\\Forms\\Components\\TextInput;
use Filament\\Forms\\Components\\Toggle;
use Filament\\Resources\\Resource;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Columns\\TextColumn;
use Filament\\Tables\\Columns\\ToggleColumn;
use Filament\\Tables\\Table;
use Illuminate\\Database\\Eloquent\\Model;
use UnitEnum;

class WebhookResource extends Resource
{
    protected static ?string $model = StrapiWebhook::class;

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-bolt';

    protected static string | UnitEnum | null $navigationGroup = 'Settings';

    protected static ?string $navigationLabel = 'Webhooks';

    private const URL = '${URL_PATTERN}';

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            TextInput::make('name')->required(),
            TextInput::make('url')->required()->rules([
                fn (): Closure => function (string $attribute, mixed $value, Closure $fail): void {
                    if (! is_string($value) || preg_match(self::URL, $value) !== 1) {
                        $fail('url must be a valid URL');
                    } elseif (app()->isProduction() && self::isLocal((string) parse_url($value, PHP_URL_HOST))) {
                        $fail("Url is not supported because it isn't reachable over the public internet");
                    }
                },
            ]),
            KeyValue::make('headers')->keyLabel('Key')->valueLabel('Value')->default([]),
            CheckboxList::make('events')
                ->options(array_combine(StrapiWebhooks::EVENTS, StrapiWebhooks::EVENTS))
                ->columns(3)
                ->required(),
            Toggle::make('enabled')->default(true),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table->columns([
            TextColumn::make('name')->searchable()->sortable(),
            TextColumn::make('url'),
            ToggleColumn::make('enabled'),
        ])->defaultSort('name');
    }

    /**
     * Strapi's is-localhost-ip: a host that is, or resolves to, a loopback, unspecified or
     * link-local address, or one of this machine's own.
     */
    public static function isLocal(string $host): bool
    {
        $host = trim($host, '[]');
        if ($host === '') {
            return true;
        }
        $addresses = filter_var($host, FILTER_VALIDATE_IP) !== false ? [$host] : (gethostbynamel($host) ?: []);
        if ($addresses === [] && in_array(strtolower($host), ['localhost', 'localhost.localdomain'], true)) {
            return true;
        }
        $self = gethostname();
        $own = is_string($self) ? (gethostbynamel($self) ?: []) : [];
        foreach ($addresses as $address) {
            $packed = @inet_pton($address);
            if ($packed === false) {
                continue;
            }
            if (in_array($address, $own, true)) {
                return true;
            }
            if (strlen($packed) === 4) {
                $first = ord($packed[0]);
                if ($first === 127 || $first === 0 || ($first === 169 && ord($packed[1]) === 254)) {
                    return true;
                }
            } elseif ($packed === inet_pton('::1') || $packed === inet_pton('::') || (ord($packed[0]) === 0xFE && (ord($packed[1]) & 0xC0) === 0x80)) {
                return true;
            }
        }

        return false;
    }

    public static function canViewAny(): bool
    {
        return ${secured ? "auth()->user()?->can('user.update') ?? false" : "auth()->check()"};
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
            'index' => ListWebhooks::route('/'),
            'create' => CreateWebhook::route('/create'),
            'edit' => EditWebhook::route('/{record}/edit'),
        ];
    }
}
`,
  },
  {
    path: "app/Filament/Resources/Webhooks/Pages/ListWebhooks.php",
    content: page("ListWebhooks", "ListRecords", [], ""),
  },
  {
    path: "app/Filament/Resources/Webhooks/Pages/CreateWebhook.php",
    content: page("CreateWebhook", "CreateRecord", [], ""),
  },
  {
    path: "app/Filament/Resources/Webhooks/Pages/EditWebhook.php",
    content: page(
      "EditWebhook",
      "EditRecord",
      [
        "App\\Support\\StrapiWebhooks",
        "Filament\\Actions\\Action",
        "Filament\\Actions\\DeleteAction",
        "Filament\\Notifications\\Notification",
      ],
      `

    protected function getHeaderActions(): array
    {
        return [
            // Strapi's Trigger button: a test event, sent now, whatever events the webhook hears.
            Action::make('trigger')
                ->action(function (): void {
                    $result = StrapiWebhooks::run($this->record, 'trigger-test');
                    $ok = $result['statusCode'] >= 200 && $result['statusCode'] < 300;
                    Notification::make()->status($ok ? 'success' : 'danger')
                        ->title($ok ? 'Success!' : "Error: {$result['statusCode']}")
                        ->body($result['message'] ?? null)
                        ->send();
                }),
            DeleteAction::make(),
        ];
    }`,
    ),
  },
];
