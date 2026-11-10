import type { GeneratedFile } from "@camis/adapter-kernel";
import { PHP_MARKER } from "../../hooks/names";
import { phpSingleQuoted } from "../../php-literal";
import { navigationProperties, SETTINGS } from "./admin-navigation";

/**
 * Strapi's admin Home: its homepage widgets (Entries, Project statistics, Last edited entries and
 * Last published entries) on Filament's dashboard, and Settings › Overview. The widgets read what
 * the signed-in user may read in the Content Manager, as Strapi's do.
 */

export const STRAPI_HOMEPAGE_PATH = "app/Support/StrapiHomepage.php";
export const SETTINGS_OVERVIEW_PAGE_PATH = "app/Filament/Pages/SettingsOverview.php";

/** A Content Manager type as the homepage reads it. */
export interface HomepageType {
  uid: string;
  model: string;
  resource: string;
  displayName: string;
  /** The column its title is read from: the main field, else id. */
  mainField: string;
  /** The grant that lets a user read it. */
  read: string;
  draftAndPublish: boolean;
  localized: boolean;
}

export interface HomepageInput {
  types: HomepageType[];
  secured: boolean;
  /** The admin roles, whose users Project statistics counts as admins (every user when unsecured). */
  adminRoles: string[];
  /** Strapi counts its components' categories. */
  componentCategories: number;
  fileModel: string | undefined;
  localized: boolean;
}

const phpBool = (value: boolean): string => (value ? "true" : "false");

const typeEntry = (t: HomepageType): string =>
  `        ${phpSingleQuoted(t.uid)} => ['model' => \\${t.model}::class, 'resource' => \\${t.resource}::class, 'displayName' => ${phpSingleQuoted(t.displayName)}, 'mainField' => ${phpSingleQuoted(t.mainField)}, 'read' => ${phpSingleQuoted(t.read)}, 'draftAndPublish' => ${phpBool(t.draftAndPublish)}, 'localized' => ${phpBool(t.localized)}],`;

const adminCount = (input: HomepageInput): string => {
  if (!input.secured) return "\\App\\Models\\User::query()->count()";
  if (input.adminRoles.length === 0) return "0";
  return `\\App\\Models\\User::query()->whereHas('roles', fn (Builder $role): Builder => $role->whereIn('name', [${input.adminRoles.map(phpSingleQuoted).join(", ")}]))->count()`;
};

const statistics = (input: HomepageInput): string =>
  [
    ...(input.fileModel === undefined
      ? []
      : [`'assets' => \\App\\Models\\${input.fileModel}::query()->count(),`]),
    `'contentTypes' => count(self::TYPES),`,
    `'components' => ${input.componentCategories},`,
    ...(input.localized ? ["'locales' => \\App\\Models\\Locale::query()->count(),"] : []),
    `'admins' => ${adminCount(input)},`,
    "'webhooks' => \\App\\Models\\StrapiWebhook::query()->count(),",
    ...(input.secured ? ["'apiTokens' => \\App\\Models\\StrapiApiToken::query()->count(),"] : []),
  ]
    .map((line) => `            ${line}`)
    .join("\n");

export const emitStrapiHomepage = (input: HomepageInput): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

use Illuminate\\Database\\Eloquent\\Builder;
use Illuminate\\Database\\Eloquent\\Model;

/** What Strapi's homepage widgets show, read from the Content Manager types the user may read. */
final class StrapiHomepage
{
    private const MAX_DOCUMENTS = 4;

    /** @var array<string, array{model: class-string<Model>, resource: class-string, displayName: string, mainField: string, read: string, draftAndPublish: bool, localized: bool}> */
    public const TYPES = [
${input.types.map(typeEntry).join("\n")}
    ];

    /**
     * The documents edited last, newest first: each type's draft (or only) rows.
     *
     * @return array<string, array{title: string, contentType: string, status: ?string, updatedAt: mixed, publishedAt: mixed, url: ?string}>
     */
    public static function lastEdited(): array
    {
        $documents = [];
        foreach (self::permitted() as $uid => $type) {
            $query = $type['model']::query();
            if ($type['draftAndPublish']) {
                $query->whereNull('published_at');
            }
            foreach ($query->orderByDesc('updated_at')->limit(self::MAX_DOCUMENTS)->get() as $row) {
                $documents["{$uid}:{$row->getKey()}"] = self::document($type, $row, $row);
            }
        }

        return self::latest($documents, 'updatedAt');
    }

    /**
     * The documents published last, newest first, from the types with draft and publish.
     *
     * @return array<string, array{title: string, contentType: string, status: ?string, updatedAt: mixed, publishedAt: mixed, url: ?string}>
     */
    public static function lastPublished(): array
    {
        $documents = [];
        foreach (self::permitted() as $uid => $type) {
            if (! $type['draftAndPublish']) {
                continue;
            }
            $rows = $type['model']::query()->whereNotNull('published_at')->orderByDesc('published_at')->limit(self::MAX_DOCUMENTS)->get();
            foreach ($rows as $row) {
                $draft = $type['model']::query()->where('document_id', $row->getAttribute('document_id'))->whereNull('published_at')
                    ->when($type['localized'], fn (Builder $query): Builder => $query->where('locale', $row->getAttribute('locale')))
                    ->first();
                $documents["{$uid}:{$row->getKey()}"] = self::document($type, $row, $draft);
            }
        }

        return self::latest($documents, 'publishedAt');
    }

    /**
     * Each document the user may read, counted once: Strapi's Entries widget. A type without
     * draft and publish counts as published; a draft edited since publishing is modified.
     *
     * @return array{draft: int, published: int, modified: int}
     */
    public static function counts(): array
    {
        $counts = ['draft' => 0, 'published' => 0, 'modified' => 0];
        foreach (self::permitted() as $type) {
            $model = new $type['model']();
            if (! $type['draftAndPublish']) {
                $query = $model->newQuery();
                $counts['published'] += $type['localized'] ? $query->distinct()->count('document_id') : $query->count();

                continue;
            }
            $connection = $model->getConnection();
            $table = $connection->getQueryGrammar()->wrapTable($model->getTable());
            $classified = "SELECT document_id, CASE
                  WHEN MAX(CASE WHEN published_at IS NOT NULL THEN 1 ELSE 0 END) = 0 THEN 'draft'
                  WHEN MAX(CASE WHEN published_at IS NULL THEN updated_at END) = MAX(CASE WHEN published_at IS NOT NULL THEN updated_at END) THEN 'published'
                  ELSE 'modified'
                END AS bucket FROM {$table} GROUP BY document_id";
            $row = $connection->selectOne("SELECT COUNT(CASE WHEN bucket = 'draft' THEN 1 END) AS draft,
                COUNT(CASE WHEN bucket = 'published' THEN 1 END) AS published,
                COUNT(CASE WHEN bucket = 'modified' THEN 1 END) AS modified FROM ({$classified}) classified");
            foreach ($counts as $bucket => $count) {
                $counts[$bucket] = $count + (int) ($row->{$bucket} ?? 0);
            }
        }

        return $counts;
    }

    /**
     * Strapi's Project statistics.
     *
     * @return array<string, int>
     */
    public static function statistics(): array
    {
        return [
${statistics(input)}
        ];
    }

    public static function readsAny(): bool
    {
        return self::permitted() !== [];
    }

    /** @return array<string, array{model: class-string<Model>, resource: class-string, displayName: string, mainField: string, read: string, draftAndPublish: bool, localized: bool}> */
    private static function permitted(): array
    {
        return array_filter(self::TYPES, fn (array $type): bool => ${input.secured ? "self::reads($type)" : "true"});
    }
${
  input.secured
    ? `
    /** @param array{read: string} $type */
    private static function reads(array $type): bool
    {
        return auth()->user()?->can($type['read']) ?? false;
    }
`
    : ""
}
    /**
     * A document as a widget lists it: its title from the shown version, its status and edit
     * link from its draft.
     *
     * @param array{resource: class-string, displayName: string, mainField: string, draftAndPublish: bool} $type
     * @return array{title: string, contentType: string, status: ?string, updatedAt: mixed, publishedAt: mixed, url: ?string}
     */
    private static function document(array $type, Model $shown, ?Model $draft): array
    {
        return [
            'title' => (string) $shown->getAttribute($type['mainField']),
            'contentType' => $type['displayName'],
            'status' => $type['draftAndPublish'] && $draft !== null ? StrapiDocuments::status($draft) : null,
            'updatedAt' => $shown->getAttribute('updated_at'),
            'publishedAt' => $type['draftAndPublish'] ? $shown->getAttribute('published_at') : null,
            'url' => $draft === null ? null : $type['resource']::getUrl('edit', ['record' => $draft]),
        ];
    }

    /**
     * @param array<string, array{updatedAt: mixed, publishedAt: mixed}> $documents
     * @return array<string, array{title: string, contentType: string, status: ?string, updatedAt: mixed, publishedAt: mixed, url: ?string}>
     */
    private static function latest(array $documents, string $by): array
    {
        uasort($documents, fn (array $a, array $b): int => strcmp((string) $b[$by], (string) $a[$by]));

        return array_slice($documents, 0, self::MAX_DOCUMENTS, true);
    }
}
`;

const widget = (cls: string, body: string): string => `<?php

declare(strict_types=1);

namespace App\\Filament\\Widgets;

${
  body.includes("TableWidget")
    ? `use App\\Support\\StrapiHomepage;
use Filament\\Tables\\Columns\\TextColumn;
use Filament\\Tables\\Table;
use Filament\\Widgets\\TableWidget;`
    : `use App\\Support\\StrapiHomepage;
use Filament\\Widgets\\StatsOverviewWidget;
use Filament\\Widgets\\StatsOverviewWidget\\Stat;`
}

${body.replace("CLASS", cls)}
`;

const entriesTable = (cls: string, heading: string, method: string, sort: number): string =>
  widget(
    cls,
    `/** Strapi's ${heading} widget. */
class CLASS extends TableWidget
{
    protected static ?int $sort = ${sort};

    protected int | string | array $columnSpan = 1;

    public static function canView(): bool
    {
        return StrapiHomepage::readsAny();
    }

    public function table(Table $table): Table
    {
        return $table
            ->heading('${heading}')
            ->records(fn (): array => StrapiHomepage::${method}())
            ->columns([
                TextColumn::make('title')->label('Name'),
                TextColumn::make('contentType')->label('Content type'),
                TextColumn::make('status')->badge()->color(fn (?string $state): string => match ($state) {
                    'Published' => 'success',
                    'Modified' => 'info',
                    default => 'gray',
                }),
                TextColumn::make('${method === "lastPublished" ? "publishedAt" : "updatedAt"}')->label('${method === "lastPublished" ? "Published" : "Last updated"}')->since(),
            ])
            ->recordUrl(fn (array $record): ?string => $record['url'])
            ->paginated(false)
            ->emptyStateHeading('No entries');
    }
}`,
  );

export const emitHomepageWidgets = (): GeneratedFile[] => [
  {
    path: "app/Filament/Widgets/StrapiEntries.php",
    content: widget(
      "StrapiEntries",
      `/** Strapi's Entries widget: the documents the user may read, by status. */
class CLASS extends StatsOverviewWidget
{
    protected static ?int $sort = 1;

    protected ?string $heading = 'Entries';

    public static function canView(): bool
    {
        return StrapiHomepage::readsAny();
    }

    protected function getStats(): array
    {
        $counts = StrapiHomepage::counts();

        return [
            Stat::make('Draft', $counts['draft']),
            Stat::make('Modified', $counts['modified']),
            Stat::make('Published', $counts['published']),
        ];
    }
}`,
    ),
  },
  {
    path: "app/Filament/Widgets/StrapiProjectStatistics.php",
    content: widget(
      "StrapiProjectStatistics",
      `/** Strapi's Project statistics widget. */
class CLASS extends StatsOverviewWidget
{
    protected static ?int $sort = 2;

    protected ?string $heading = 'Project statistics';

    private const LABELS = [
        'assets' => 'Assets',
        'contentTypes' => 'Content-Types',
        'components' => 'Components',
        'locales' => 'Locales',
        'admins' => 'Admins',
        'webhooks' => 'Webhooks',
        'apiTokens' => 'API Tokens',
    ];

    protected function getStats(): array
    {
        $stats = [];
        foreach (StrapiHomepage::statistics() as $key => $count) {
            $stats[] = Stat::make(self::LABELS[$key] ?? $key, $count);
        }

        return $stats;
    }
}`,
    ),
  },
  {
    path: "app/Filament/Widgets/StrapiLastEditedEntries.php",
    content: entriesTable("StrapiLastEditedEntries", "Last edited entries", "lastEdited", 3),
  },
  {
    path: "app/Filament/Widgets/StrapiLastPublishedEntries.php",
    content: entriesTable(
      "StrapiLastPublishedEntries",
      "Last published entries",
      "lastPublished",
      4,
    ),
  },
];

/** Strapi's Settings › Overview: the application's details. */
export const emitSettingsOverviewPage = (secured: boolean): string => `<?php

declare(strict_types=1);

namespace App\\Filament\\Pages;

use App\\Filament\\StrapiNavigation;
use BackedEnum;
use Composer\\InstalledVersions;
use Filament\\Forms\\Components\\Placeholder;
use Filament\\Pages\\Page;
use Filament\\Schemas\\Components\\Section;
use Filament\\Schemas\\Schema;
use UnitEnum;

/** The application's details, where Strapi shows its own and Node's versions. */
class SettingsOverview extends Page
{
    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-information-circle';
${navigationProperties(SETTINGS.overview)}
    protected static ?string $title = 'Overview';

    protected ?string $subheading = 'Administration panel’s global information';

    public static function canAccess(): bool
    {
        return ${secured ? "auth()->user()?->can('user.update') ?? false" : "true"};
    }

    public function content(Schema $schema): Schema
    {
        return $schema->components([
            Section::make('Details')
                ->columns(2)
                ->schema([
                    Placeholder::make('laravel')->label('Laravel version')->content(app()->version()),
                    Placeholder::make('filament')->label('Filament version')->content(InstalledVersions::getPrettyVersion('filament/filament') ?? '-'),
                    Placeholder::make('php')->label('PHP version')->content(PHP_VERSION),
                    Placeholder::make('database')->label('Database')->content((string) config('database.connections.'.config('database.default').'.driver')),
                    Placeholder::make('environment')->label('Environment')->content(app()->environment()),
                ]),
        ]);
    }
}
`;
