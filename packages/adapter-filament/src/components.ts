import { columnField, type ExpandedScalar, type ExpandedTable } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { emitField, type FieldEmit } from "./fields";
import { filamentNames, snake, snakeColumn } from "./names";
import type { RelationMethod } from "./relations";
import { mediaAllowedTypes } from "./strapi-api/media";
import { mediaRelationMethod } from "./strapi-api/media-runtime";

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
  /** Its media fields, when the project has a media library: links to its files, not columns. */
  media: ChildMedia[];
}

/** A media field of a repeatable component's item, linked to the library through its own row. */
export interface ChildMedia {
  /** Its path within the item. */
  path: string[];
  /** The same path in the keys its fields go by on the API. */
  apiPath: string[];
  /** The item model's relation to its files. */
  method: string;
  multiple: boolean;
  /** The kinds of file it takes, when not every kind. */
  allowedTypes?: string[];
}

/**
 * With `linksMedia` (the Strapi API style keeps a media library) an item's media fields become
 * links from its own row, as Strapi links a component's; otherwise each is a path column.
 */
export const childTableEmit = (
  ct: ContentType,
  table: ExpandedTable,
  linksMedia = false,
): ChildTableEmit => {
  const parent = filamentNames(ct);
  const pathSnake = table.path.map(snakeColumn).join("_");
  const isLink = (s: ExpandedScalar): boolean => linksMedia && s.field.type === "media";
  return {
    table: `${parent.table}_${pathSnake}`,
    model: `${parent.model}${table.path.map(studlySegment).join("")}`,
    fk: `${snake(ct.name)}_id`,
    relationName: camelPath(table.path),
    emits: table.scalars
      .filter((s) => !isLink(s))
      .map((s) => emitField(columnField(s), s.path.map(snakeColumn).join("_"))),
    media: table.scalars.filter(isLink).map((s) => ({
      path: s.path,
      apiPath: s.apiPath,
      method: camelPath(s.path),
      multiple: s.field.type === "media" && s.field.multiple === true,
      ...mediaAllowedTypes(s.field),
    })),
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

/** `fileModel` is the media library's model, which an item's media fields link to. */
export const emitChildModel = (child: ChildTableEmit, fileModel = "File"): string => {
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
  const media = child.media.map(
    (m) => `\n${mediaRelationMethod(m.path.join("."), m.method, fileModel)}\n`,
  );
  const hasMedia = child.media.length > 0 ? "\n    use \\App\\Models\\Concerns\\HasMedia;\n" : "";
  return `<?php

declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;

class ${child.model} extends Model
{${hasMedia}
    protected $table = '${child.table}';

    protected $fillable = [
${fillable}
    ];
${castsMethod}${media.join("")}}
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
  const inner = [
    ...child.emits.map((e) => e.formComponent),
    ...child.media.map(
      (m) =>
        `MediaPicker::make('${m.method}', multiple: ${m.multiple}${m.allowedTypes === undefined ? "" : `, allowedTypes: [${m.allowedTypes.map((t) => `'${t}'`).join(", ")}]`})`,
    ),
  ]
    .map((c) => `                ${c},`)
    .join("\n");
  return {
    component: `Repeater::make('${child.relationName}')->relationship()->schema([\n${inner}\n            ])`,
    imports: [
      "Filament\\Forms\\Components\\Repeater",
      ...child.emits.map((e) => e.formImport),
      ...(child.media.length > 0 ? ["App\\Filament\\Support\\MediaPicker"] : []),
    ],
  };
};
