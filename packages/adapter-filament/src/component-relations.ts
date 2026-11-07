import type { ExpandedRelation } from "@camis/adapter-kernel";
import type { Component, ContentType, IrDocument } from "@camis/ir-schema";
import { constrainedTo, uniqueOn } from "./identifiers";
import { filamentNames, snake, snakeColumn } from "./names";
import type { ForeignKeyColumn, RelationMethod } from "./relations";

const studlySegment = (segment: string): string =>
  segment.charAt(0).toUpperCase() + segment.slice(1);

const camelPath = (path: string[]): string =>
  path.map((s, i) => (i === 0 ? s : studlySegment(s))).join("");

/** The link table of a to-many relation inside a component, as Strapi's `*_lnk` tables are. */
export interface ComponentPivot {
  table: string;
  /** The table of the row holding the component (the entry's, or an item's). */
  holderTable: string;
  holderKey: string;
  targetTable: string;
  targetKey: string;
  /** The target's place in the holder's list (Strapi's `*_ord`). */
  order: string;
  /** Kept beside it so `StrapiLinkPivot` numbers both sides alike; nothing reads it. */
  holderOrder: string;
}

/**
 * A relation inside a component, held by the row the component lives on. A to-one is a foreign
 * key on that row; a to-many is a link table keeping the targets' order, as Strapi keeps one per
 * component relation. Strapi's component relations go one way, so the target lists nothing back.
 */
export interface ComponentRelation {
  path: string[];
  apiPath: string[];
  /** The component declaring it. */
  component: Component;
  /** The holder model's Eloquent relation (`ctaAuthor`). */
  method: string;
  target: ContentType;
  many: boolean;
  /** How the component declares it (an archive's links name it). */
  relationKind: ExpandedRelation["field"]["relationKind"];
  /** A to-one's foreign key on the holder's table. */
  foreignKey: ForeignKeyColumn | null;
  pivot: ComponentPivot | null;
}

/**
 * `holderTable` is the table the component's columns live on and `holderKey` the key a link table
 * names it by (`menu_id`, `menu_items_id`). A link to a row that goes away (deleted, unpublished,
 * a locale removed) unlinks, as Strapi drops its link rows.
 */
export const componentRelations = (
  doc: IrDocument,
  holderTable: string,
  holderKey: string,
  relations: readonly ExpandedRelation[],
): ComponentRelation[] =>
  relations.map((r) => {
    const target = doc.contentTypes.find((c) => c.name === r.field.target);
    if (target === undefined) throw new Error(`unknown relation target "${r.field.target}"`);
    const targetTable = filamentNames(target).table;
    const pathSnake = r.path.map(snakeColumn).join("_");
    const many = r.field.relationKind === "oneToMany" || r.field.relationKind === "manyToMany";
    const ownKey = `${snake(target.name)}_id`;
    // A link from a type to itself names the target's side as Strapi does: `inv_`.
    const targetKey = ownKey === holderKey ? `inv_${ownKey}` : ownKey;
    const column = `${pathSnake}_id`;
    return {
      path: r.path,
      apiPath: r.apiPath,
      component: r.component,
      method: camelPath(r.path),
      target,
      many,
      relationKind: r.field.relationKind,
      foreignKey: many
        ? null
        : {
            column,
            references: target.name,
            table: targetTable,
            definition: `$table->foreignId('${column}')->nullable()`,
            onDelete: "->nullOnDelete()",
          },
      pivot: many
        ? {
            table: `${holderTable}_${pathSnake}_lnk`,
            holderTable,
            holderKey,
            targetTable,
            targetKey,
            order: `${targetKey.slice(0, -"_id".length)}_ord`,
            holderOrder: `${holderKey.slice(0, -"_id".length)}_ord`,
          }
        : null,
    };
  });

/** The holder model's Eloquent relation to the targets. */
export const componentRelationMethod = (r: ComponentRelation): RelationMethod => {
  const model = filamentNames(r.target).model;
  if (r.pivot === null) {
    return {
      import: "Illuminate\\Database\\Eloquent\\Relations\\BelongsTo",
      php: `    public function ${r.method}(): BelongsTo\n    {\n        return $this->belongsTo(${model}::class, '${r.foreignKey!.column}');\n    }`,
    };
  }
  const p = r.pivot;
  return {
    import: "Illuminate\\Database\\Eloquent\\Relations\\BelongsToMany",
    php: `    public function ${r.method}(): BelongsToMany\n    {\n        return $this->belongsToMany(${model}::class, '${p.table}', '${p.holderKey}', '${p.targetKey}')->using(\\App\\Support\\StrapiLinkPivot::class);\n    }`,
  };
};

export const componentPivotMigrationFilename = (pivot: ComponentPivot, ordinal: number): string =>
  `database/migrations/0001_01_02_${String(ordinal).padStart(6, "0")}_create_${pivot.table}_table.php`;

export const emitComponentPivotMigration = (pivot: ComponentPivot): string => `<?php

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('${pivot.table}', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('${pivot.holderKey}')${constrainedTo(pivot.table, pivot.holderKey, pivot.holderTable)}->cascadeOnDelete();
            $table->foreignId('${pivot.targetKey}')${constrainedTo(pivot.table, pivot.targetKey, pivot.targetTable)}->cascadeOnDelete();
            $table->double('${pivot.order}')->nullable();
            $table->double('${pivot.holderOrder}')->nullable();
            ${uniqueOn(pivot.table, [pivot.holderKey, pivot.targetKey])};
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('${pivot.table}');
    }
};
`;

/**
 * The admin's picker for a relation inside a component. `field` is the name the form keys it by:
 * a to-one's foreign key, a to-many's relation. A draft-and-publish target is linked through its
 * draft and a localized one in the record's locale (`locale` reaches it from where the picker
 * sits) or, from a type without locales, in the default one.
 */
export const componentRelationPicker = (
  r: ComponentRelation,
  versioned: ReadonlySet<string>,
  localized: ReadonlySet<string>,
  locale: string | null,
): string => {
  const main = r.target.fields.find((f) => f.type === "string");
  const label = main === undefined ? "id" : snakeColumn(main.name);
  const narrow = [
    ...(versioned.has(r.target.name) ? ["->whereNull('published_at')"] : []),
    ...(localized.has(r.target.name)
      ? [
          locale === null
            ? "->where('locale', \\App\\Support\\StrapiLocales::default())"
            : `->where('locale', $get('${locale}'))`,
        ]
      : []),
  ];
  const args = localized.has(r.target.name) && locale !== null ? "$query, $get" : "$query";
  const modify =
    narrow.length === 0 ? "" : `, modifyQueryUsing: fn (${args}) => $query${narrow.join("")}`;
  return r.pivot === null
    ? `Select::make('${r.foreignKey!.column}')->relationship(name: '${r.method}', titleAttribute: '${label}'${modify})`
    : `Select::make('${r.method}')->multiple()->relationship(name: '${r.method}', titleAttribute: '${label}'${modify})`;
};

/**
 * The same pick inside a dynamic zone's block, which keeps no relationship of its own: the
 * targets are listed as options and `StrapiZones` writes the pick with the item. A target that
 * keeps locales is listed in the record's locale.
 */
export const componentRelationOptions = (
  r: ComponentRelation,
  versioned: ReadonlySet<string>,
  localized: ReadonlySet<string>,
): string => {
  const main = r.target.fields.find((f) => f.type === "string");
  const label = main === undefined ? "id" : snakeColumn(main.name);
  const narrow = [
    ...(versioned.has(r.target.name) ? ["->whereNull('published_at')"] : []),
    ...(localized.has(r.target.name)
      ? [
          "->where('locale', $record?->getAttribute('locale') ?? \\App\\Support\\StrapiLocales::default())",
        ]
      : []),
  ];
  const args = localized.has(r.target.name)
    ? "?\\Illuminate\\Database\\Eloquent\\Model $record"
    : "";
  const options = `->options(fn (${args}) => \\App\\Models\\${filamentNames(r.target).model}::query()${narrow.join("")}->pluck('${label}', 'id')->all())->searchable()`;
  return r.pivot === null
    ? `Select::make('${r.foreignKey!.column}')${options}`
    : `Select::make('${r.method}')->multiple()${options}`;
};
