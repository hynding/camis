import {
  fieldApiName,
  type CapabilityGap,
  type ContentType,
  type Field,
  type IrDocument,
} from "@camis/ir-schema";
import { PHP_MARKER } from "../../hooks/names";
import { runtimePhp } from "../../runtime-php";
import type { RelationMethod } from "../../relations";
import { filamentNames, snake, snakeColumn } from "../../names";
import { strapiUid, type WireRelation } from "./wire-shape";

type PolymorphicRelation = Extract<Field, { type: "polymorphicRelation" }>;
type PolymorphicInverse = Extract<Field, { type: "polymorphicInverse" }>;

/** How a polymorphic relation's links are stored, from the side that names them. */
export type WireMorph =
  | {
      kind: "morphToMany";
      key: string;
      /** Strapi's `<table>_<field>_mph`: a row per link, its entry's id and uid, ordered. */
      table: string;
      ownerColumn: string;
      idColumn: string;
      typeColumn: string;
      private?: true;
    }
  | { kind: "morphToOne"; key: string; idColumn: string; typeColumn: string; private?: true };

const isPolymorphic = (f: { type: string }): boolean =>
  f.type === "polymorphicRelation" || f.type === "polymorphicInverse";

const owning = (ct: ContentType, f: PolymorphicRelation): WireMorph => {
  const base = snakeColumn(f.name);
  const columns = { idColumn: `${base}_id`, typeColumn: `${base}_type` };
  const privacy = f.private === true ? { private: true as const } : {};
  return f.many
    ? {
        kind: "morphToMany",
        key: fieldApiName(f),
        table: `${filamentNames(ct).table}_${base}_mph`,
        ownerColumn: `${snake(ct.name)}_id`,
        ...columns,
        ...privacy,
      }
    : { kind: "morphToOne", key: fieldApiName(f), ...columns, ...privacy };
};

interface MorphInverse {
  wire: WireRelation;
  method: RelationMethod;
}

const REL_NS = "Illuminate\\Database\\Eloquent\\Relations";

/**
 * An inverse is an ordinary relation read through the target's link: its two columns, or its link
 * table by the link's uid and field, which is how Strapi tells which inverse a link fills.
 */
const inverse = (
  ct: ContentType,
  f: PolymorphicInverse,
  source: ContentType,
  via: PolymorphicRelation,
  versioned: ReadonlySet<string>,
  localized: ReadonlySet<string>,
): MorphInverse => {
  const link = owning(source, via);
  const model = filamentNames(source).model;
  const uid = strapiUid(ct);
  const [rel, call] =
    link.kind === "morphToOne"
      ? [
          f.many ? "HasMany" : "HasOne",
          `$this->${f.many ? "hasMany" : "hasOne"}(\\App\\Models\\${model}::class, '${link.idColumn}')->where('${link.typeColumn}', '${uid}')`,
        ]
      : [
          "BelongsToMany",
          `$this->belongsToMany(\\App\\Models\\${model}::class, '${link.table}', '${link.idColumn}', '${link.ownerColumn}')->wherePivot('${link.typeColumn}', '${uid}')->wherePivot('field', '${fieldApiName(f)}')`,
        ];
  return {
    wire: {
      key: fieldApiName(f),
      relation: f.name,
      kind: link.kind === "morphToOne" ? (f.many ? "hasMany" : "hasOne") : "belongsToMany",
      model,
      foreignKey: link.kind === "morphToOne" ? link.idColumn : null,
      uid: strapiUid(source),
      holder: "target",
      draftPublish: versioned.has(source.name),
      localized: localized.has(source.name),
      order: null,
      inverseOrder: null,
      readOnly: true,
      ...(f.private === true ? { private: true as const } : {}),
    },
    method: {
      import: `${REL_NS}\\${rel}`,
      php: `    public function ${f.name}(): ${rel}\n    {\n        return ${call};\n    }`,
    },
  };
};

export interface MorphPlan {
  /** The document every other emitter reads: without its polymorphic fields. */
  doc: IrDocument;
  gaps: CapabilityGap[];
  /** Each content type's owning sides, by name. */
  owners: Map<string, WireMorph[]>;
  /** Each content type's inverses, by name. */
  inverses: Map<string, MorphInverse[]>;
}

const gapAt = (ct: ContentType, f: Field, feature: string, message: string): CapabilityGap => ({
  feature,
  location: { contentType: ct.name, field: f.name },
  severity: "downgrade",
  message,
});

/**
 * Strapi's polymorphic relations are served on the Strapi API style over Laravel storage, as
 * Strapi's REST API serves them (the Content Manager shows none); elsewhere each is reported.
 */
export const morphPlan = (
  doc: IrDocument,
  apiStyle: string,
  storage: string,
  options: {
    graphql?: boolean;
    versioned?: ReadonlySet<string>;
    localized?: ReadonlySet<string>;
  } = {},
): MorphPlan => {
  const served = apiStyle === "strapi" && storage !== "strapi";
  const byName = new Map(doc.contentTypes.map((c) => [c.name, c]));
  const gaps: CapabilityGap[] = [];
  const owners = new Map<string, WireMorph[]>();
  const inverses = new Map<string, MorphInverse[]>();
  for (const ct of doc.contentTypes) {
    for (const f of ct.fields) {
      if (f.type !== "polymorphicRelation" && f.type !== "polymorphicInverse") continue;
      if (!served) {
        gaps.push(
          gapAt(
            ct,
            f,
            f.type,
            `polymorphic relation "${f.name}" is served on the Strapi API style over Laravel storage only; skipped.`,
          ),
        );
        continue;
      }
      if (f.type === "polymorphicRelation") {
        owners.set(ct.name, [...(owners.get(ct.name) ?? []), owning(ct, f)]);
      } else {
        const source = byName.get(f.target);
        const via = source?.fields.find(
          (s): s is PolymorphicRelation => s.type === "polymorphicRelation" && s.name === f.via,
        );
        if (source === undefined || via === undefined) continue; // unreachable on validated IR
        if (via.many && !f.many) {
          gaps.push(
            gapAt(
              ct,
              f,
              f.type,
              `polymorphic inverse "${f.name}" reads one entry through the to-many "${f.target}.${f.via}", which this target does not serve; skipped.`,
            ),
          );
          continue;
        }
        const read = inverse(
          ct,
          f,
          source,
          via,
          options.versioned ?? new Set(),
          options.localized ?? new Set(),
        );
        inverses.set(ct.name, [...(inverses.get(ct.name) ?? []), read]);
      }
      if (options.graphql === true) {
        gaps.push(
          gapAt(
            ct,
            f,
            "polymorphicGraphql",
            `polymorphic relation "${f.name}" is served over REST only; the GraphQL schema leaves it out.`,
          ),
        );
      }
    }
  }
  const stripped: IrDocument = {
    ...doc,
    contentTypes: doc.contentTypes.map((ct) => ({
      ...ct,
      fields: ct.fields.filter((f) => !isPolymorphic(f)),
    })),
  };
  return { doc: stripped, gaps, owners, inverses };
};

/** The columns a to-one's link takes on its entry's row, as a create-table migration declares them. */
export const morphColumns = (owners: readonly WireMorph[]): string[] =>
  owners.flatMap((m) =>
    m.kind === "morphToOne"
      ? [
          `$table->unsignedBigInteger('${m.idColumn}')->nullable()`,
          `$table->string('${m.typeColumn}')->nullable()`,
        ]
      : [],
  );

/** A to-many's link table: its rows go with their entry, its targets are whatever the uid names. */
export const emitMorphTableMigration = (
  m: Extract<WireMorph, { kind: "morphToMany" }>,
  ownerTable: string,
): string => `<?php

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('${m.table}', function (Blueprint $table): void {
            $table->id();
            $table->foreignId('${m.ownerColumn}')->constrained('${ownerTable}')->cascadeOnDelete();
            $table->unsignedBigInteger('${m.idColumn}');
            $table->string('${m.typeColumn}');
            $table->string('field')->nullable();
            $table->float('order')->nullable();
            $table->index(['${m.typeColumn}', '${m.idColumn}']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('${m.table}');
    }
};
`;

/** A morph field's entry in a serializer's FIELDS: no column, no relation, its storage. */
export const morphEntry = (m: WireMorph, indent: string): string => {
  const storage =
    m.kind === "morphToMany"
      ? `'table' => '${m.table}', 'ownerColumn' => '${m.ownerColumn}', `
      : "";
  return `${indent}'${m.key}' => ['morph' => '${m.kind}', ${storage}'idColumn' => '${m.idColumn}', 'typeColumn' => '${m.typeColumn}'${m.private === true ? ", 'private' => true" : ""}],`;
};

/** Every content type a link may name, by its Strapi uid: what a written `__type` resolves to. */
export const emitMorphTypes = (types: readonly ContentType[]): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

final class StrapiMorphTypes
{
    /** Strapi uid → [model, serializer], for each type a polymorphic link may hold. */
    public const TYPES = [
${types
  .map((t) => {
    const model = filamentNames(t).model;
    return `        '${strapiUid(t)}' => [\\App\\Models\\${model}::class, \\App\\Http\\Serializers\\${model}Serializer::class],`;
  })
  .join("\n")}
    ];
}
`;

/** Writes, publishes and reads polymorphic links (`php/app/Support/StrapiMorphs.php`). */
export const emitStrapiMorphs = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiMorphs.php", import.meta.url));
