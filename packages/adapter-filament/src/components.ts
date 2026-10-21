import { columnField, type ExpandedTable } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { emitField, type FieldEmit } from "./fields";
import { filamentNames, snake, snakeColumn } from "./names";
import type { RelationMethod } from "./relations";

const studlySegment = (segment: string): string =>
  segment.charAt(0).toUpperCase() + segment.slice(1);

export const camelPath = (path: string[]): string =>
  path.map((s, i) => (i === 0 ? s : studlySegment(s))).join("");

export interface ChildTableEmit {
  table: string;
  model: string;
  fk: string;
  relationName: string;
  emits: FieldEmit[];
  /** A dynamic zone member's rows: they keep the item's place in the zone. */
  ordered?: boolean;
}

export const childTableEmit = (ct: ContentType, table: ExpandedTable): ChildTableEmit => {
  const parent = filamentNames(ct);
  const pathSnake = table.path.map(snakeColumn).join("_");
  return {
    table: `${parent.table}_${pathSnake}`,
    model: `${parent.model}${table.path.map(studlySegment).join("")}`,
    fk: `${snake(ct.name)}_id`,
    relationName: camelPath(table.path),
    emits: table.scalars.map((s) => emitField(columnField(s), s.path.map(snakeColumn).join("_"))),
  };
};

export const childMigrationFilename = (child: ChildTableEmit, ordinal: number): string =>
  `database/migrations/0001_01_02_${String(ordinal).padStart(6, "0")}_create_${child.table}_table.php`;

export const emitChildMigration = (ct: ContentType, child: ChildTableEmit): string => {
  const parent = filamentNames(ct);
  const columns = child.emits.map((e) => `            ${e.migration};`).join("\n");
  return `<?php

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('${child.table}', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('${child.fk}')->constrained('${parent.table}')->cascadeOnDelete();${child.ordered === true ? "\n            $table->unsignedInteger('position');" : ""}
${columns}
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('${child.table}');
    }
};
`;
};

export const emitChildModel = (child: ChildTableEmit): string => {
  const fillable = [
    ...(child.ordered === true ? ["position"] : []),
    ...child.emits.map((e) => e.column),
  ]
    .map((column) => `        '${column}',`)
    .join("\n");
  const casts = child.emits
    .filter((e) => e.cast !== undefined)
    .map((e) => `            '${e.column}' => ${e.cast},`)
    .join("\n");
  const castsMethod =
    casts.length > 0
      ? `\n    protected function casts(): array\n    {\n        return [\n${casts}\n        ];\n    }\n`
      : "";
  return `<?php

declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class ${child.model} extends Model
{
    protected $table = '${child.table}';

    protected $fillable = [
${fillable}
    ];
${castsMethod}}
`;
};

export const childRelationMethod = (child: ChildTableEmit): RelationMethod => ({
  import: "Illuminate\\Database\\Eloquent\\Relations\\HasMany",
  php: `    public function ${child.relationName}(): HasMany\n    {\n        return $this->hasMany(${child.model}::class, '${child.fk}');\n    }`,
});

export interface RepeaterEmit {
  component: string;
  imports: string[];
}

export const repeaterComponent = (child: ChildTableEmit): RepeaterEmit => {
  const inner = child.emits.map((e) => `                ${e.formComponent},`).join("\n");
  return {
    component: `Repeater::make('${child.relationName}')->relationship()->schema([\n${inner}\n            ])`,
    imports: ["Filament\\Forms\\Components\\Repeater", ...child.emits.map((e) => e.formImport)],
  };
};
