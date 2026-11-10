import type { ContentType } from "@camis/ir-schema";
import type { GeneratedFile } from "@camis/adapter-kernel";
import type { RepeaterEmit } from "./components";
import { emitField, type FieldEmit } from "./fields";
import { filamentNames } from "./names";
import {
  CREATE_ACTION_IMPORT,
  createNewEntryActions,
  navigationProperties,
  STRAPI_NAVIGATION_CLASS,
  type Navigation,
} from "./strapi-api/admin/admin-navigation";
import {
  listedColumn,
  mainFieldName,
  searchesNumbers,
} from "./strapi-api/content-manager/content-manager-list";
import {
  configureViewAction,
  configureViewPage,
  CONTENT_MANAGER_TABLE_IMPORTS,
  contentManagerForm,
  contentManagerFormBody,
  contentManagerResourceMembers,
  contentManagerTableBody,
  DUPLICATE_CREATE_IMPORTS,
  DUPLICATE_IMPORTS,
  duplicateAction,
  duplicateCreateBody,
  type ContentManagerInput,
} from "./strapi-api/content-manager/content-manager-resource";

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
    /** The Content Manager lists through the model's forAdmin scope (some admin role reads under a condition). */
    adminScoped?: boolean;
    /** Media fields, picked from the media library. */
    media?: {
      field: string;
      multiple: boolean;
      allowedTypes?: readonly string[];
      /** The attribute it belongs to: the field, or the embedded component holding it. */
      attribute?: string;
    }[];
    /** Its place in a Strapi-like menu, which also words the list's create button as Strapi's. */
    navigation?: Navigation;
    /** A Content Manager type's attributes, laid out as Strapi's "Configure the view" says. */
    contentManager?: ContentManagerInput;
  } = {},
): GeneratedFile[] => {
  const versioned = options.versioned === true;
  const navigation = options.navigation;
  const localized = options.localized === true;
  // A document's rows (versions, locales) share every value, so per-row uniqueness cannot hold.
  const manyRows = versioned || localized;
  const LOCALE_OPTIONS = "fn (): array => Locale::query()->pluck('name', 'code')->all()";
  const n = filamentNames(ct);
  const dir = `app/Filament/Resources/${n.resourceDir}`;
  const ns = `App\\Filament\\Resources\\${n.resourceDir}`;
  const ownFields = ct.fields.filter((f) => f.type !== "relation" && f.type !== "component");
  const ownEmits = ownFields.map((f) => emitField(f));
  const emits = [...ownEmits, ...extraEmits];

  // Page class names follow v5's make:filament-resource convention: List<plural>, Create<singular>, Edit<singular>.
  const listPage = `List${n.resourceDir}`;
  const createPage = `Create${n.subject}`;
  const editPage = `Edit${n.subject}`;
  // On a Strapi-like admin a single type opens its one entry, as Strapi's Content Manager does.
  const single = navigation !== undefined && ct.kind === "single";
  // A Strapi-like collection type lists as the Content Manager does.
  const contentManagerList = navigation !== undefined && !single;
  // A draft-and-publish entry is deleted with every version of it, as Strapi deletes a document.
  const deletesDocument = navigation !== undefined && versioned;
  const secured = options.secured === true;
  // A Content Manager type (not a Settings one) lays its list and form out as its view configures.
  const cm =
    navigation !== undefined && navigation.group !== "Settings"
      ? options.contentManager
      : undefined;
  const cmCollection = cm !== undefined && !single;
  const formComponentOf = (e: FieldEmit): string =>
    manyRows ? e.formComponent.replace("->unique()", "") : e.formComponent;
  const mediaComponent = (m: NonNullable<typeof options.media>[number]): string =>
    `MediaPicker::make('${m.field}', multiple: ${m.multiple}${m.allowedTypes === undefined ? "" : `, allowedTypes: [${m.allowedTypes.map((t) => `'${t}'`).join(", ")}]`})`;
  const cmForm =
    cm === undefined
      ? undefined
      : contentManagerForm(
          ct,
          cm,
          { fields: ownFields, emits: ownEmits },
          extraEmits,
          relationFields,
          (options.media ?? []).map((m) => ({
            component: mediaComponent(m),
            attribute: m.attribute ?? m.field,
          })),
          repeaters.map((r) => r.component),
          { localized, formComponent: formComponentOf },
        );
  const configure = cm === undefined ? undefined : configureViewPage(ns, n);

  const adminScoped = options.adminScoped === true;
  // One row per document: its draft, which every edit goes through, with its published version.
  // An admin account lists and opens only the rows its roles may read.
  const ownQuery = `${versioned ? `->whereNull('published_at')${localized ? "" : "->with('publishedVersion')"}` : ""}${adminScoped ? "->forAdmin(Filament::auth()->user())" : ""}`;
  const listQuery =
    ownQuery === ""
      ? ""
      : `

    public static function getEloquentQuery(): Builder
    {
        return parent::getEloquentQuery()${ownQuery};
    }`;

  const resource = `<?php

declare(strict_types=1);

namespace ${ns};

use BackedEnum;
use ${ns}\\Pages\\${createPage};
use ${ns}\\Pages\\${editPage};
use ${ns}\\Pages\\${listPage};${configure === undefined ? "" : `\nuse ${ns}\\Pages\\${configure.cls};`}
use ${ns}\\Schemas\\${n.formClass};
use ${ns}\\Schemas\\${n.tableClass};${navigation === undefined ? "" : `\nuse ${STRAPI_NAVIGATION_CLASS};`}
use App\\Models\\${n.model};${cmCollection ? `\nuse App\\Http\\Serializers\\${n.model}Serializer;\nuse App\\Support\\StrapiDocuments;` : ""}
${adminScoped ? "use Filament\\Facades\\Filament;\n" : ""}use Filament\\Resources\\Resource;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Table;${single && secured ? "\nuse Illuminate\\Auth\\Access\\Response;" : ""}${versioned || adminScoped ? "\nuse Illuminate\\Database\\Eloquent\\Builder;" : ""}${deletesDocument ? "\nuse Illuminate\\Support\\Facades\\DB;" : ""}${single && secured ? "\nuse Illuminate\\Support\\Facades\\Gate;" : ""}${single && localized ? "\nuse App\\Support\\StrapiLocales;" : ""}${navigation === undefined ? "" : "\nuse UnitEnum;"}

class ${n.resourceClass} extends Resource
{
    protected static ?string $model = ${n.model}::class;

    protected static string | BackedEnum | null $navigationIcon = 'heroicon-o-rectangle-stack';
${navigation === undefined ? "" : navigationProperties(navigation)}
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
            'edit' => ${editPage}::route('/{record}/edit'),${configure === undefined ? "" : `\n            'configure' => ${configure.cls}::route('/configure-the-view'),`}
        ];
    }${listQuery}${single ? singleEntry(n.model, localized, secured) : ""}${deletesDocument ? deleteEntry(n.model, localized) : ""}${
      cmForm === undefined
        ? ""
        : contentManagerResourceMembers(ct, cmForm.attributes, n, {
            secured,
            collection: cmCollection,
            prohibited: cm?.prohibited ?? [],
          })
    }
}
`;

  const SELECT = "Filament\\Forms\\Components\\Select";
  const formImports = useBlock([
    ...emits.map((e) => e.formImport),
    ...(relationFields.length > 0 || localized ? [SELECT] : []),
    ...(localized ? ["App\\Models\\Locale", "App\\Support\\StrapiLocales"] : []),
    ...((options.media ?? []).length > 0 ? ["App\\Filament\\Support\\MediaPicker"] : []),
    ...repeaters.flatMap((r) => r.imports),
    ...(cmForm === undefined
      ? []
      : [`${ns}\\${n.resourceClass}`, "App\\Support\\StrapiContentManager", ...cmForm.imports]),
    "Filament\\Schemas\\Schema",
  ]);
  const localeSelect = `Select::make('locale')->options(${LOCALE_OPTIONS})->default(fn (): string => StrapiLocales::default())->required()->disabledOn('edit')`;
  const formBody = [
    ...(localized ? [`            ${localeSelect},`] : []),
    ...emits.map((e) => `            ${formComponentOf(e)},`),
    ...relationFields.map((s) => `            ${s},`),
    ...(options.media ?? []).map((m) => `            ${mediaComponent(m)},`),
    ...repeaters.map((r) => `            ${r.component},`),
  ].join("\n");
  const formReturn =
    cmForm === undefined
      ? `        return $schema->components([
${formBody}
        ]);`
      : contentManagerFormBody(cmForm, n.resourceClass, localized ? [localeSelect] : []);
  const form = `<?php

declare(strict_types=1);

namespace ${ns}\\Schemas;

${formImports}

class ${n.formClass}
{
    public static function configure(Schema $schema): Schema
    {
${formReturn}
    }
}
`;

  const TEXT_COLUMN = "Filament\\Tables\\Columns\\TextColumn";
  const bulkPublishing = contentManagerList && versioned;
  const main = mainFieldName(ct);
  const mainColumn =
    main === undefined ? "id" : ownEmits[ownFields.findIndex((f) => f.name === main)]!.column;
  const statusColumn =
    "TextColumn::make('status')->state(fn ($record) => StrapiDocuments::status($record))->badge()";
  const localeColumn = "TextColumn::make('locale')->badge()";
  const localeFilter = `SelectFilter::make('locale')->options(${LOCALE_OPTIONS})->default(StrapiLocales::default())`;
  const cmTable =
    cmForm === undefined || !cmCollection
      ? undefined
      : contentManagerTableBody(
          cmForm.attributes,
          n.resourceClass,
          [...(versioned ? [statusColumn] : []), ...(localized ? [localeColumn] : [])],
          localized ? [localeFilter] : [],
        );
  const usedIn = (body: string, imports: readonly string[]): string[] =>
    imports.filter((i) => body.includes(`${i.split("\\").pop()!}::`));
  const tableImports = useBlock([
    ...(cmTable === undefined
      ? emits.map((e) => e.tableImport)
      : [
          ...usedIn(cmTable, [
            ...CONTENT_MANAGER_TABLE_IMPORTS,
            ...emits.map((e) => e.tableImport),
          ]),
          `${ns}\\${n.resourceClass}`,
          `App\\Models\\${n.model}`,
          ...DUPLICATE_IMPORTS,
        ]),
    ...(contentManagerList
      ? [
          "Filament\\Actions\\BulkActionGroup",
          "Filament\\Actions\\DeleteAction",
          "Filament\\Actions\\DeleteBulkAction",
        ]
      : []),
    ...(contentManagerList && searchesNumbers(ownFields)
      ? ["Illuminate\\Database\\Eloquent\\Builder"]
      : []),
    ...(deletesDocument && contentManagerList
      ? [
          `${ns}\\${n.resourceClass}`,
          `App\\Models\\${n.model}`,
          "Illuminate\\Database\\Eloquent\\Collection",
        ]
      : []),
    ...(bulkPublishing
      ? [
          "Filament\\Actions\\BulkAction",
          `App\\Http\\Serializers\\${n.model}Serializer`,
          "App\\Support\\StrapiDocuments",
        ]
      : []),
    ...(bulkPublishing && secured ? ["Illuminate\\Support\\Facades\\Gate"] : []),
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
  const tableColumns = [
    ...ownEmits.map(
      (e, i) =>
        `            ${contentManagerList ? listedColumn(ownFields[i]!, e.column, e.tableColumn) : e.tableColumn},`,
    ),
    ...extraEmits.map((e) => `            ${e.tableColumn},`),
    ...(versioned ? [`            ${statusColumn},`] : []),
    ...(localized ? [`            ${localeColumn},`] : []),
  ].join("\n");
  // One locale at a time, the default one first, as Strapi's content manager lists them.
  const tableFilters = localized
    ? `->filters([
            ${localeFilter},
        ])`
    : "";
  const actions = contentManagerList
    ? contentManagerActions(n, mainColumn, {
        versioned,
        secured,
        ...(cmTable === undefined ? {} : { prohibited: cm?.prohibited ?? [] }),
      })
    : "";
  const tableReturn =
    cmTable === undefined
      ? `        return $table->columns([
${tableColumns}
        ])${tableFilters}${actions};`
      : `        return ${cmTable}${actions};`;
  const table = `<?php

declare(strict_types=1);

namespace ${ns}\\Schemas;

${tableImports}

class ${n.tableClass}
{
    public static function configure(Table $table): Table
    {
${tableReturn}
    }
}
`;

  const page = (
    cls: string,
    base: string,
    baseImport: string,
    body = "",
    imports: readonly string[] = [],
  ): string => `<?php

declare(strict_types=1);

namespace ${ns}\\Pages;

${useBlock([`${ns}\\${n.resourceClass}`, baseImport, ...(body === createNewEntryActions ? [CREATE_ACTION_IMPORT] : []), ...imports])}

class ${cls} extends ${base}
{
    protected static string $resource = ${n.resourceClass}::class;${body}
}
`;
  const openEntry = `$this->redirect(${n.resourceClass}::getUrl('edit', ['record' => $entry]));`;
  const listBody = single
    ? `

    /** Strapi's Content Manager opens a single type's one entry, or its create form while it has none. */
    public function mount(): void
    {
        parent::mount();
        $entry = ${n.resourceClass}::entry();
        if ($entry !== null) {
            ${openEntry}
        } elseif (${n.resourceClass}::canCreate()) {
            $this->redirect(${n.resourceClass}::getUrl('create'));
        }
    }`
    : cmCollection
      ? `

    protected function getHeaderActions(): array
    {
        return [
            ${configureViewAction(n)},
            CreateAction::make()->label('Create new entry'),
        ];
    }`
      : navigation !== undefined
        ? createNewEntryActions
        : "";
  const listImports = cmCollection ? [CREATE_ACTION_IMPORT, "Filament\\Actions\\Action"] : [];
  const createBody = single
    ? `

    /** A single type has one entry: once it is made, its edit page is where it changes. */
    public function mount(): void
    {
        $entry = ${n.resourceClass}::entry();
        if ($entry !== null) {
            ${openEntry}

            return;
        }
        parent::mount();
    }`
    : cmCollection
      ? duplicateCreateBody(n)
      : "";

  return [
    { path: `${dir}/${n.resourceClass}.php`, content: resource },
    { path: `${dir}/Schemas/${n.formClass}.php`, content: form },
    { path: `${dir}/Schemas/${n.tableClass}.php`, content: table },
    {
      path: `${dir}/Pages/${listPage}.php`,
      content: page(
        listPage,
        "ListRecords",
        "Filament\\Resources\\Pages\\ListRecords",
        listBody,
        listImports,
      ),
    },
    {
      path: `${dir}/Pages/${createPage}.php`,
      content: page(
        createPage,
        "CreateRecord",
        "Filament\\Resources\\Pages\\CreateRecord",
        createBody,
        cmCollection ? DUPLICATE_CREATE_IMPORTS : [],
      ),
    },
    ...(configure === undefined
      ? []
      : [{ path: `${dir}/Pages/${configure.cls}.php`, content: configure.content }]),
    {
      path: `${dir}/Pages/${editPage}.php`,
      content:
        versioned || localized || navigation !== undefined
          ? editPageWithActions(ns, n.resourceClass, editPage, n.model, {
              secured: options.secured === true,
              versioned,
              localized,
              deletable: navigation !== undefined,
              ...(cm === undefined
                ? {}
                : { contentManager: { names: n, single, prohibited: cm.prohibited } }),
            })
          : page(editPage, "EditRecord", "Filament\\Resources\\Pages\\EditRecord"),
    },
  ];
};

type Names = ReturnType<typeof filamentNames>;

/** How a document is deleted: with every version of it where it has several, else its own row. */
const deleteUsing = (n: Names, versioned: boolean): string =>
  versioned ? `->using(fn (${n.model} $record) => ${n.resourceClass}::deleteEntry($record))` : "";

/**
 * The Content Manager list's sort and actions: it starts sorted by the main field, deletes an entry
 * from its row, and deletes, publishes and unpublishes the selected ones, each behind its grant.
 */
const contentManagerActions = (
  n: Names,
  mainColumn: string,
  options: { versioned: boolean; secured: boolean; prohibited?: readonly string[] },
): string => {
  const { versioned, secured, prohibited } = options;
  // A Content Manager type sorts, and offers bulk actions, as its view configures; it duplicates.
  const cm = prohibited !== undefined;
  // Filament checks only deleteAny for a bulk delete unless told to check each record too.
  const bulkDelete = `${secured ? "->authorizeIndividualRecords()" : ""}${
    versioned
      ? `->using(fn (Collection $records) => $records->each(fn (${n.model} $record) => ${n.resourceClass}::deleteEntry($record)))`
      : ""
  }`;
  const guarded = (ability: string): string =>
    secured
      ? `
                        ->visible(fn (): bool => Gate::allows('${ability}Any', ${n.model}::class))
                        ->authorizeIndividualRecords('${ability}')`
      : "";
  const publishing = versioned
    ? `
                    BulkAction::make('publish')${guarded("publish")}
                        ->action(fn (Collection $records) => $records->each(fn (${n.model} $record) => StrapiDocuments::publish($record, ${n.model}Serializer::class))),
                    BulkAction::make('unpublish')${guarded("publish")}
                        ->requiresConfirmation()
                        ->action(fn (Collection $records) => $records->each(fn (${n.model} $record) => StrapiDocuments::unpublish($record))),`
    : "";
  const bulk = `BulkActionGroup::make([
                    DeleteBulkAction::make()${bulkDelete},${publishing}
                ])`;
  return cm
    ? `
            ->recordActions([
                ${duplicateAction(n, prohibited, "$record")},
                DeleteAction::make()${deleteUsing(n, versioned)},
            ])
            ->toolbarActions(StrapiContentManager::bulkActions(${n.resourceClass}::CONTENT_MANAGER, [
                ${bulk},
            ]))`
    : `
            ->defaultSort('${mainColumn}')
            ->recordActions([
                DeleteAction::make()${deleteUsing(n, versioned)},
            ])
            ->toolbarActions([
                ${bulk},
            ])`;
};

/** Deletes the entry with every version of it, in its locale only, as Strapi deletes a document. */
const deleteEntry = (model: string, localized: boolean): string => `

    public static function deleteEntry(${model} $record): void
    {
        DB::transaction(fn () => ${model}::query()->where('document_id', $record->document_id)${localized ? "->where('locale', $record->locale)" : ""}->get()->each->delete());
    }`;

/**
 * A single type's one entry, as its list and create pages find it: the row the resource lists (a
 * draft-and-publish type's draft), in the default locale where it has several. Strapi's single
 * type has no create action, so its update grant makes the entry, as on the API.
 */
const singleEntry = (model: string, localized: boolean, secured: boolean): string => `

    public static function entry(): ?${model}
    {
        return static::getEloquentQuery()${localized ? "->orderByRaw('locale = ? desc', [StrapiLocales::default()])" : ""}->orderBy('id')->first();
    }${
      secured
        ? `

    public static function getCreateAuthorizationResponse(): Response
    {
        return Gate::inspect('update', new ${model}());
    }`
        : ""
    }`;

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
  options: {
    secured: boolean;
    versioned: boolean;
    localized: boolean;
    deletable: boolean;
    /** A Content Manager type duplicates (a collection type) or configures its view (a single one). */
    contentManager?: { names: Names; single: boolean; prohibited: readonly string[] };
  },
): string => {
  const { secured, versioned, localized, deletable, contentManager } = options;
  const allowed = (ability: string, subject = "$this->record"): string =>
    secured ? `Gate::allows('${ability}', ${subject})` : "true";
  const published = "$this->record->publishedVersion()->exists()";
  const imports = useBlock([
    `${ns}\\${resourceClass}`,
    ...(versioned || localized ? ["Filament\\Actions\\Action"] : []),
    "Filament\\Resources\\Pages\\EditRecord",
    ...(versioned
      ? [`App\\Http\\Serializers\\${model}Serializer`, "App\\Support\\StrapiDocuments"]
      : []),
    ...(localized ? ["App\\Models\\Locale", "Filament\\Forms\\Components\\Select"] : []),
    ...((localized && secured) || (deletable && versioned) ? [`App\\Models\\${model}`] : []),
    ...(deletable ? ["Filament\\Actions\\DeleteAction"] : []),
    ...(contentManager === undefined
      ? []
      : contentManager.single
        ? ["Filament\\Actions\\Action"]
        : [...DUPLICATE_IMPORTS, `App\\Models\\${model}`]),
    ...(secured && (versioned || localized) ? ["Illuminate\\Support\\Facades\\Gate"] : []),
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
  // Strapi's edit page deletes the entry (in its locale), behind the delete grant.
  const deleting = deletable
    ? `
            DeleteAction::make()${versioned ? `->using(fn (${model} $record) => ${resourceClass}::deleteEntry($record))` : ""},`
    : "";
  const cmActions =
    contentManager === undefined
      ? ""
      : `
            ${
              contentManager.single
                ? configureViewAction(contentManager.names)
                : duplicateAction(
                    contentManager.names,
                    contentManager.prohibited,
                    "$record",
                  ).replace(/\n {20}/g, "\n                ")
            },`;
  return `<?php

declare(strict_types=1);

namespace ${ns}\\Pages;

${imports}

class ${cls} extends EditRecord
{
    protected static string $resource = ${resourceClass}::class;

    protected function getHeaderActions(): array
    {
        return [${publishing}${translating}${cmActions}${deleting}
        ];
    }
}
`;
};
