import type { ContentType } from "@camis/ir-schema";
import type { GeneratedFile } from "@camis/adapter-kernel";
import type { RepeaterEmit } from "./components";
import { emitField, type FieldEmit } from "./fields";
import { filamentNames } from "./names";

const useBlock = (imports: string[]): string =>
  [...new Set(imports)]
    .sort()
    .map((i) => `use ${i};`)
    .join("\n");

export const emitResourceFiles = (
  ct: ContentType,
  relationFields: string[] = [],
  extraEmits: FieldEmit[] = [],
  repeaters: RepeaterEmit[] = [],
  options: {
    versioned?: boolean;
    localized?: boolean;
    secured?: boolean;
    /** Media fields, picked from the media library. */
    media?: { field: string; multiple: boolean }[];
  } = {},
): GeneratedFile[] => {
  const versioned = options.versioned === true;
  const localized = options.localized === true;
  // A document's rows (versions, locales) share every value, so per-row uniqueness cannot hold.
  const manyRows = versioned || localized;
  const LOCALE_OPTIONS = "fn (): array => Locale::query()->pluck('name', 'code')->all()";
  const n = filamentNames(ct);
  const dir = `app/Filament/Resources/${n.resourceDir}`;
  const ns = `App\\Filament\\Resources\\${n.resourceDir}`;
  const emits = [
    ...ct.fields
      .filter((f) => f.type !== "relation" && f.type !== "component")
      .map((f) => emitField(f)),
    ...extraEmits,
  ];

  // Page class names follow v5's make:filament-resource convention: List<plural>, Create<singular>, Edit<singular>.
  const listPage = `List${n.resourceDir}`;
  const createPage = `Create${n.model}`;
  const editPage = `Edit${n.model}`;

  // One row per document: its draft, which every edit goes through, with its published version.
  const draftQuery = `

    public static function getEloquentQuery(): Builder
    {
        return parent::getEloquentQuery()->whereNull('published_at')${localized ? "" : "->with('publishedVersion')"};
    }`;

  const resource = `<?php

declare(strict_types=1);

namespace ${ns};

use BackedEnum;
use ${ns}\\Pages\\${createPage};
use ${ns}\\Pages\\${editPage};
use ${ns}\\Pages\\${listPage};
use ${ns}\\Schemas\\${n.formClass};
use ${ns}\\Schemas\\${n.tableClass};
use App\\Models\\${n.model};
use Filament\\Resources\\Resource;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Table;${versioned ? "\nuse Illuminate\\Database\\Eloquent\\Builder;" : ""}

class ${n.resourceClass} extends Resource
{
    protected static ?string $model = ${n.model}::class;

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-rectangle-stack';

    public static function form(Schema $schema): Schema
    {
        return ${n.formClass}::configure($schema);
    }

    public static function table(Table $table): Table
    {
        return ${n.tableClass}::configure($table);
    }

    public static function getPages(): array
    {
        return [
            'index' => ${listPage}::route('/'),
            'create' => ${createPage}::route('/create'),
            'edit' => ${editPage}::route('/{record}/edit'),
        ];
    }${versioned ? draftQuery : ""}
}
`;

  const SELECT = "Filament\\Forms\\Components\\Select";
  const formImports = useBlock([
    ...emits.map((e) => e.formImport),
    ...(relationFields.length > 0 || localized ? [SELECT] : []),
    ...(localized ? ["App\\Models\\Locale", "App\\Support\\StrapiLocales"] : []),
    ...((options.media ?? []).length > 0 ? ["App\\Filament\\Support\\MediaPicker"] : []),
    ...repeaters.flatMap((r) => r.imports),
    "Filament\\Schemas\\Schema",
  ]);
  const formBody = [
    ...(localized
      ? [
          `            Select::make('locale')->options(${LOCALE_OPTIONS})->default(fn (): string => StrapiLocales::default())->required()->disabledOn('edit'),`,
        ]
      : []),
    ...emits.map(
      (e) =>
        `            ${manyRows ? e.formComponent.replace("->unique()", "") : e.formComponent},`,
    ),
    ...relationFields.map((s) => `            ${s},`),
    ...(options.media ?? []).map(
      (m) => `            MediaPicker::make('${m.field}', multiple: ${m.multiple}),`,
    ),
    ...repeaters.map((r) => `            ${r.component},`),
  ].join("\n");
  const form = `<?php

declare(strict_types=1);

namespace ${ns}\\Schemas;

${formImports}

class ${n.formClass}
{
    public static function configure(Schema $schema): Schema
    {
        return $schema->components([
${formBody}
        ]);
    }
}
`;

  const TEXT_COLUMN = "Filament\\Tables\\Columns\\TextColumn";
  const tableImports = useBlock([
    ...emits.map((e) => e.tableImport),
    ...(versioned ? [TEXT_COLUMN, "App\\Support\\StrapiDocuments"] : []),
    ...(localized
      ? [
          TEXT_COLUMN,
          "App\\Models\\Locale",
          "App\\Support\\StrapiLocales",
          "Filament\\Tables\\Filters\\SelectFilter",
        ]
      : []),
    "Filament\\Tables\\Table",
  ]);
  const tableBody = [
    ...emits.map((e) => `            ${e.tableColumn},`),
    ...(versioned
      ? [
          "            TextColumn::make('status')->state(fn ($record) => StrapiDocuments::status($record))->badge(),",
        ]
      : []),
    ...(localized ? ["            TextColumn::make('locale')->badge(),"] : []),
  ].join("\n");
  // One locale at a time, the default one first, as Strapi's content manager lists them.
  const tableFilters = localized
    ? `->filters([
            SelectFilter::make('locale')->options(${LOCALE_OPTIONS})->default(StrapiLocales::default()),
        ])`
    : "";
  const table = `<?php

declare(strict_types=1);

namespace ${ns}\\Schemas;

${tableImports}

class ${n.tableClass}
{
    public static function configure(Table $table): Table
    {
        return $table->columns([
${tableBody}
        ])${tableFilters};
    }
}
`;

  const page = (cls: string, base: string, baseImport: string): string => `<?php

declare(strict_types=1);

namespace ${ns}\\Pages;

use ${ns}\\${n.resourceClass};
use ${baseImport};

class ${cls} extends ${base}
{
    protected static string $resource = ${n.resourceClass}::class;
}
`;

  return [
    { path: `${dir}/${n.resourceClass}.php`, content: resource },
    { path: `${dir}/Schemas/${n.formClass}.php`, content: form },
    { path: `${dir}/Schemas/${n.tableClass}.php`, content: table },
    {
      path: `${dir}/Pages/${listPage}.php`,
      content: page(listPage, "ListRecords", "Filament\\Resources\\Pages\\ListRecords"),
    },
    {
      path: `${dir}/Pages/${createPage}.php`,
      content: page(createPage, "CreateRecord", "Filament\\Resources\\Pages\\CreateRecord"),
    },
    {
      path: `${dir}/Pages/${editPage}.php`,
      content:
        versioned || localized
          ? editPageWithActions(ns, n.resourceClass, editPage, n.model, {
              secured: options.secured === true,
              versioned,
              localized,
            })
          : page(editPage, "EditRecord", "Filament\\Resources\\Pages\\EditRecord"),
    },
  ];
};

/**
 * The edit page of a draft-and-publish type edits the draft; its header actions publish it (saving
 * first), drop the published version, or reset the draft to it. A localized type's edit page edits
 * one locale and translates the document into a locale it lacks, as a copy to edit. Each action is
 * behind the caller's grant.
 */
const editPageWithActions = (
  ns: string,
  resourceClass: string,
  cls: string,
  model: string,
  options: { secured: boolean; versioned: boolean; localized: boolean },
): string => {
  const { secured, versioned, localized } = options;
  const allowed = (ability: string, subject = "$this->record"): string =>
    secured ? `Gate::allows('${ability}', ${subject})` : "true";
  const published = "$this->record->publishedVersion()->exists()";
  const imports = useBlock([
    `${ns}\\${resourceClass}`,
    "Filament\\Actions\\Action",
    "Filament\\Resources\\Pages\\EditRecord",
    ...(versioned
      ? [`App\\Http\\Serializers\\${model}Serializer`, "App\\Support\\StrapiDocuments"]
      : []),
    ...(localized ? ["App\\Models\\Locale", "Filament\\Forms\\Components\\Select"] : []),
    ...(localized && secured ? [`App\\Models\\${model}`] : []),
    ...(secured ? ["Illuminate\\Support\\Facades\\Gate"] : []),
  ]);
  const publishing = versioned
    ? `
            Action::make('publish')
                ->visible(fn (): bool => ${allowed("publish")})
                ->action(function (): void {
                    $this->save();
                    StrapiDocuments::publish($this->record, ${model}Serializer::class);
                }),
            Action::make('unpublish')
                ->visible(fn (): bool => ${allowed("publish")} && ${published})
                ->requiresConfirmation()
                ->action(fn () => StrapiDocuments::unpublish($this->record)),
            Action::make('discard')
                ->label('Discard changes')
                ->visible(fn (): bool => ${allowed("update")} && ${published})
                ->requiresConfirmation()
                ->action(function (): void {
                    $this->record = StrapiDocuments::discard($this->record, ${model}Serializer::class);
                    $this->fillForm();
                }),`
    : "";
  const translating = localized
    ? `
            Action::make('translate')
                ->visible(fn (): bool => ${allowed("create", `${model}::class`)})
                ->schema([
                    Select::make('locale')
                        ->options(fn (): array => Locale::query()->whereNotIn('code', $this->record->localizations()->pluck('locale'))->pluck('name', 'code')->all())
                        ->required(),
                ])
                ->action(function (array $data): void {
                    $copy = $this->record->replicate();
                    $copy->locale = $data['locale'];
                    $copy->save();
                    $this->redirect(${resourceClass}::getUrl('edit', ['record' => $copy]));
                }),`
    : "";
  return `<?php

declare(strict_types=1);

namespace ${ns}\\Pages;

${imports}

class ${cls} extends EditRecord
{
    protected static string $resource = ${resourceClass}::class;

    protected function getHeaderActions(): array
    {
        return [${publishing}${translating}
        ];
    }
}
`;
};
