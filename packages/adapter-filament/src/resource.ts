import type { ContentType } from "@camis/ir-schema";
import type { GeneratedFile } from "@camis/adapter-kernel";
import { emitField } from "./fields";
import { filamentNames } from "./names";

const useBlock = (imports: string[]): string =>
  [...new Set(imports)]
    .sort()
    .map((i) => `use ${i};`)
    .join("\n");

export const emitResourceFiles = (ct: ContentType): GeneratedFile[] => {
  const n = filamentNames(ct);
  const dir = `app/Filament/Resources/${n.resourceDir}`;
  const ns = `App\\Filament\\Resources\\${n.resourceDir}`;
  const emits = ct.fields.map(emitField);

  // Page class names follow v5's make:filament-resource convention: List<plural>, Create<singular>, Edit<singular>.
  const listPage = `List${n.resourceDir}`;
  const createPage = `Create${n.model}`;
  const editPage = `Edit${n.model}`;

  const resource = `<?php

declare(strict_types=1);

namespace ${ns};

use ${ns}\\Pages\\${createPage};
use ${ns}\\Pages\\${editPage};
use ${ns}\\Pages\\${listPage};
use ${ns}\\Schemas\\${n.formClass};
use ${ns}\\Schemas\\${n.tableClass};
use App\\Models\\${n.model};
use Filament\\Resources\\Resource;
use Filament\\Schemas\\Schema;
use Filament\\Tables\\Table;

class ${n.resourceClass} extends Resource
{
    protected static ?string $model = ${n.model}::class;

    protected static ?string $navigationIcon = 'heroicon-o-rectangle-stack';

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
    }
}
`;

  const formImports = useBlock([...emits.map((e) => e.formImport), "Filament\\Schemas\\Schema"]);
  const formBody = emits.map((e) => `            ${e.formComponent},`).join("\n");
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

  const tableImports = useBlock([...emits.map((e) => e.tableImport), "Filament\\Tables\\Table"]);
  const tableBody = emits.map((e) => `            ${e.tableColumn},`).join("\n");
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
      content: page(editPage, "EditRecord", "Filament\\Resources\\Pages\\EditRecord"),
    },
  ];
};
