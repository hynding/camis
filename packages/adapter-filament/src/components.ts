import { columnField, type ExpandedScalar, type ExpandedTable } from "@camis/adapter-kernel";
import type { ContentType, IrDocument } from "@camis/ir-schema";
import {
  componentRelationMethod,
  componentRelationPicker,
  componentRelations,
  type ComponentRelation,
} from "./component-relations";
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
  /** The table the foreign key points at: the entry's, or the item's this one is nested in. */
  parentTable: string;
  relationName: string;
  emits: FieldEmit[];
  /** A dynamic zone member's rows: they keep the item's place in the zone. */
  ordered?: boolean;
  /** Its media fields, when the project has a media library: links to its files, not columns. */
  media: ChildMedia[];
  /** Relations inside the item, held by its row. */
  relations: ComponentRelation[];
  /** Repeatables inside the item: tables of their own, keyed by the item's id. */
  children: ChildTableEmit[];
}

/** What a child table needs beyond its own expansion: relation targets, and the row holding it. */
export interface ChildContext {
  doc: IrDocument;
  /** The item table this one is nested in; the entry's when absent. */
  parent?: ChildTableEmit;
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
  context?: ChildContext,
): ChildTableEmit => {
  const owner = filamentNames(ct);
  const parent = context?.parent;
  const pathSnake = table.path.map(snakeColumn).join("_");
  const isLink = (s: ExpandedScalar): boolean => linksMedia && s.field.type === "media";
  const name = parent?.table ?? owner.table;
  const model = `${parent?.model ?? owner.model}${table.path.map(studlySegment).join("")}`;
  const self = {
    table: `${name}_${pathSnake}`,
    model,
    fk: parent === undefined ? `${snake(ct.name)}_id` : `${snake(parent.model)}_id`,
    parentTable: name,
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
  const holderKey = `${snake(model)}_id`;
  const relations =
    context === undefined
      ? []
      : componentRelations(context.doc, self.table, holderKey, table.relations);
  const emit: ChildTableEmit = { ...self, relations, children: [] };
  emit.children =
    context === undefined
      ? []
      : table.tables.map((t) =>
          childTableEmit(ct, t, linksMedia, { doc: context.doc, parent: emit }),
        );
  return emit;
};

/** The table and every table nested in its items, parents first. */
export const childTablesWithin = (child: ChildTableEmit): ChildTableEmit[] => [
  child,
  ...child.children.flatMap(childTablesWithin),
];

/** Whether deleting an item must go one row at a time: it, or an item nested in it, links files. */
export const linksFilesWithin = (child: ChildTableEmit): boolean =>
  child.media.length > 0 || child.children.some(linksFilesWithin);

export const childMigrationFilename = (child: ChildTableEmit, ordinal: number): string =>
  `database/migrations/0001_01_02_${String(ordinal).padStart(6, "0")}_create_${child.table}_table.php`;

export const emitChildMigration = (child: ChildTableEmit): string => {
  const columns = [
    ...child.emits.map((e) => e.migration),
    ...child.relations.flatMap((r) =>
      r.foreignKey === null
        ? []
        : [
            `${r.foreignKey.definition}->constrained('${r.foreignKey.table}')${r.foreignKey.onDelete}`,
          ],
    ),
  ]
    .map((line) => `            ${line};`)
    .join("\n");
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
            $table->foreignId('${child.fk}')->constrained('${child.parentTable}')->cascadeOnDelete();${child.ordered === true ? "\n            $table->unsignedInteger('position');" : ""}
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
    ...child.relations.flatMap((r) => (r.foreignKey === null ? [] : [r.foreignKey.column])),
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
  const methods = [
    ...child.children.map(childRelationMethod),
    ...child.relations.map(componentRelationMethod),
  ];
  const links = methods.map((m) => `\n${m.php}\n`);
  const imports = [...new Set(methods.map((m) => m.import))]
    .sort()
    .map((i) => `\nuse ${i};`)
    .join("");
  // Its nested items go one by one when any of them links files, so their links go too.
  const nestedFiles = child.children.filter(linksFilesWithin).map((c) => c.relationName);
  const hasMedia =
    child.media.length > 0 || nestedFiles.length > 0
      ? "\n    use \\App\\Models\\Concerns\\HasMedia;\n"
      : "";
  const mediaComponents =
    nestedFiles.length > 0
      ? `\n    public const MEDIA_COMPONENTS = [${nestedFiles.map((r) => `'${r}'`).join(", ")}];\n`
      : "";
  return `<?php

declare(strict_types=1);

namespace App\\Models;

use Illuminate\\Database\\Eloquent\\Model;${imports}

class ${child.model} extends Model
{${hasMedia}
    protected $table = '${child.table}';

    protected $fillable = [
${fillable}
    ];
${mediaComponents}${castsMethod}${media.join("")}${links.join("")}}
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

/**
 * `depth` is how many repeaters the item sits in (1 for an entry's own): a picker reaches the
 * record's locale that many items up. `pickers` says how a relation inside the item is picked.
 */
export const repeaterComponent = (
  child: ChildTableEmit,
  pickers: RelationPickers = NO_PICKERS,
  depth = 1,
): RepeaterEmit => {
  const nested = child.children.map((c) => repeaterComponent(c, pickers, depth + 1));
  const pad = "    ".repeat(depth - 1);
  const inner = [
    ...child.emits.map((e) => e.formComponent),
    ...child.media.map(
      (m) =>
        `MediaPicker::make('${m.method}', multiple: ${m.multiple}${m.allowedTypes === undefined ? "" : `, allowedTypes: [${m.allowedTypes.map((t) => `'${t}'`).join(", ")}]`})`,
    ),
    ...child.relations.map((r) =>
      componentRelationPicker(r, pickers.versioned, pickers.localized, pickers.locale(depth)),
    ),
    ...nested.map((n) => n.component),
  ]
    .map((c) => `${pad}                ${c},`)
    .join("\n");
  return {
    component: `Repeater::make('${child.relationName}')->relationship()->schema([\n${inner}\n${pad}            ])`,
    imports: [
      "Filament\\Forms\\Components\\Repeater",
      ...child.emits.map((e) => e.formImport),
      ...(child.media.length > 0 ? ["App\\Filament\\Support\\MediaPicker"] : []),
      ...(child.relations.length > 0 ? ["Filament\\Forms\\Components\\Select"] : []),
      ...nested.flatMap((n) => n.imports),
    ],
  };
};

/** How the admin picks a relation inside a component: what the record's draft and locale narrow. */
export interface RelationPickers {
  versioned: ReadonlySet<string>;
  localized: ReadonlySet<string>;
  /** The record's locale field seen from `depth` repeaters down, or null when it keeps none. */
  locale: (depth: number) => string | null;
}

export const NO_PICKERS: RelationPickers = {
  versioned: new Set(),
  localized: new Set(),
  locale: () => null,
};

/** Pickers for a record of `ct`: its locale field is two levels up per repeater it sits in. */
export const relationPickers = (
  ct: ContentType,
  versioned: ReadonlySet<string>,
  localized: ReadonlySet<string>,
): RelationPickers => ({
  versioned,
  localized,
  locale: (depth) => (localized.has(ct.name) ? `${"../".repeat(2 * depth)}locale` : null),
});
