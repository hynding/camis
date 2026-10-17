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
  options: { versioned?: boolean; secured?: boolean } = {},
): GeneratedFile[] => {
  const versioned = options.versioned === true;
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
        return parent::getEloquentQuery()->whereNull('published_at')->with('publishedVersion');
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
    ...(relationFields.length > 0 ? [SELECT] : []),
    ...repeaters.flatMap((r) => r.imports),
    "Filament\\Schemas\\Schema",
  ]);
  const formBody = [
    // A draft and its published version share every value, so per-row uniqueness cannot hold.
    ...emits.map(
      (e) =>
        `            ${versioned ? e.formComponent.replace("->unique()", "") : e.formComponent},`,
    ),
    ...relationFields.map((s) => `            ${s},`),
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
    "Filament\\Tables\\Table",
  ]);
  const tableBody = [
    ...emits.map((e) => `            ${e.tableColumn},`),
    ...(versioned
      ? [
          "            TextColumn::make('status')->state(fn ($record) => StrapiDocuments::status($record))->badge(),",
        ]
      : []),
  ].join("\n");
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
        ]);
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
      content: versioned
        ? versionedEditPage(ns, n.resourceClass, editPage, n.model, options.secured === true)
        : page(editPage, "EditRecord", "Filament\\Resources\\Pages\\EditRecord"),
    },
  ];
};

/**
 * The edit page of a draft-and-publish type edits the draft; its header actions publish it (saving
 * first), drop the published version, or reset the draft to it, each behind the caller's grant.
 */
const versionedEditPage = (
  ns: string,
  resourceClass: string,
  cls: string,
  model: string,
  secured: boolean,
): string => {
  const allowed = (ability: string): string =>
    secured ? `Gate::allows('${ability}', $this->record)` : "true";
  const published = "$this->record->publishedVersion()->exists()";
  const imports = useBlock([
    `${ns}\\${resourceClass}`,
    `App\\Http\\Serializers\\${model}Serializer`,
    "App\\Support\\StrapiDocuments",
    "Filament\\Actions\\Action",
    "Filament\\Resources\\Pages\\EditRecord",
    ...(secured ? ["Illuminate\\Support\\Facades\\Gate"] : []),
  ]);
  return `<?php

declare(strict_types=1);

namespace ${ns}\\Pages;

${imports}

class ${cls} extends EditRecord
{
    protected static string $resource = ${resourceClass}::class;

    protected function getHeaderActions(): array
    {
        return [
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
                }),
        ];
    }
}
`;
};
