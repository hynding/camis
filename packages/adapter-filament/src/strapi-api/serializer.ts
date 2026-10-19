import type { StorageLayout } from "@camis/adapter-kernel";
import { PHP_MARKER } from "../hooks/names";
import type { WireChild, WireRelation, WireScalar, WireShape } from "./wire-shape";

const NUMERIC_INT = new Set(["integer"]);
// Strapi renders a `biginteger` as a string: a 64-bit value does not survive a JSON number.
const NUMERIC_STRING = new Set(["bigInteger"]);
const NUMERIC_FLOAT = new Set(["float", "decimal"]);
const DATETIME = new Set(["dateTime", "timestamp"]);
// Strapi renders a `date` attribute as YYYY-MM-DD; a datetime would append a fabricated time.
const DATE_ONLY = new Set(["date"]);
// Strapi renders a datetime the way JavaScript's Date#toISOString does — UTC, three fractional
// digits. Carbon's toJSON() emits six, which is the same instant in a shape Strapi never sends.
const ZULU_MS = "?->toIso8601ZuluString('millisecond')";

// One PSR-12 indent level.
const UNIT = "    ";

// PHP expression producing the wire value for one column of `$src`.
//
// `layout` decides only what a `date` already is. On the Laravel storage layout it arrives as a
// Carbon (the model's 'date' cast, and StrapiComponents' matching component-scalar conversion);
// on the Strapi one it is deliberately uncast (spec 17i) and already holds Strapi's own `Y-m-d`
// string, which `?->toDateString()` would fatal on.
const read = (s: WireScalar, src: string, layout: StorageLayout): string => {
  const col = `${src}->${s.column}`;
  if (NUMERIC_INT.has(s.type)) return `${col} === null ? null : (int) ${col}`;
  if (NUMERIC_STRING.has(s.type)) return `${col} === null ? null : (string) ${col}`;
  if (NUMERIC_FLOAT.has(s.type)) return `${col} === null ? null : (float) ${col}`;
  if (DATE_ONLY.has(s.type)) return layout === "strapi" ? col : `${col}?->toDateString()`;
  if (DATETIME.has(s.type)) return `${col}${ZULU_MS}`;
  return col;
};

// Build a nested PHP array literal from scalars whose keys are paths.
interface Node {
  leaves: Map<string, string>;
  branches: Map<string, Node>;
}
const node = (): Node => ({ leaves: new Map(), branches: new Map() });
const insert = (root: Node, key: string[], expr: string): void => {
  let cur = root;
  key.slice(0, -1).forEach((seg) => {
    let next = cur.branches.get(seg);
    if (!next) {
      next = node();
      cur.branches.set(seg, next);
    }
    cur = next;
  });
  cur.leaves.set(key[key.length - 1]!, expr);
};
// `self::nested(...)` (not `omitNulls`) for branches: an all-null component must
// disappear from its parent array entirely, not survive as `[]` (a JSON array),
// so the enclosing `omitNulls` needs a `null` to filter out, not an empty array.
const render = (n: Node, indent: string): string => {
  const rows: string[] = [];
  for (const [k, v] of n.leaves) rows.push(`${indent}'${k}' => ${v},`);
  for (const [k, b] of n.branches)
    rows.push(`${indent}'${k}' => self::nested([\n${render(b, `${indent}${UNIT}`)}\n${indent}]),`);
  return rows.join("\n");
};

const toWireBody = (shape: WireShape, indent: string, layout: StorageLayout): string => {
  const root = node();
  insert(root, ["id"], "$m->id");
  insert(root, ["documentId"], "$m->document_id");
  for (const s of shape.scalars) insert(root, s.key, read(s, "$m", layout));
  for (const c of shape.children) {
    const inner = node();
    for (const s of c.scalars) insert(inner, s.key, read(s, "$c", layout));
    // The child's own row is rendered by `render` one branch level per path segment above
    // it (depth = c.key.length - 1), matching how it indents a nested `self::nested([`
    // branch body — so the map's rows sit a further level in, and its closing
    // `]))...` aligns with the row it hangs off, not with the toplevel `indent`.
    const depth = c.key.length;
    const rowIndent = `${indent}${UNIT.repeat(depth)}`;
    const closeIndent = `${indent}${UNIT.repeat(depth - 1)}`;
    // Drop an all-null row from the list (self::nested → null) rather than emit `[]` for it.
    insert(
      root,
      c.key,
      `$m->${c.relation}->map(fn ($c) => self::nested([\n${render(inner, rowIndent)}\n${closeIndent}]))->filter(fn ($r) => $r !== null)->values()->all()`,
    );
  }
  insert(root, ["createdAt"], `$m->created_at${ZULU_MS}`);
  insert(root, ["updatedAt"], `$m->updated_at${ZULU_MS}`);
  if (shape.localized && layout === "laravel") insert(root, ["locale"], "$m->locale");
  return render(root, indent);
};

const fromWireColumns = (scalars: WireScalar[], src: string, indent: string): string =>
  scalars
    .map(
      (s) =>
        `${indent}'${s.column}' => self::dig(${src}, [${s.key.map((k) => `'${k}'`).join(", ")}]),`,
    )
    .join("\n");

// Each child key is set only when the wire payload mentions it, mirroring `syncChildren`'s
// `array_key_exists` guard: an absent key leaves existing rows untouched, an explicit `[]`
// clears them. A single unconditional entry (falling back to `[]`) would collapse that
// distinction and make every `fromWire` call wipe children the client never mentioned.
const fromWireChildStatements = (children: WireChild[], indent: string): string => {
  if (children.length === 0) return `${indent}$children = [];`;
  const blocks = children.map((c) => {
    const assignIndent = `${indent}${UNIT}`;
    const rowIndent = `${assignIndent}${UNIT}`;
    const path = c.key.map((k) => `'${k}'`).join(", ");
    return `${indent}if (self::has($data, [${path}])) {
${assignIndent}$children['${c.relation}'] = array_map(fn (array $row) => array_filter([
${fromWireColumns(c.scalars, "$row", rowIndent)}
${assignIndent}], fn ($v) => $v !== null), is_array(self::dig($data, [${path}])) ? self::dig($data, [${path}]) : []);
${indent}}`;
  });
  return [`${indent}$children = [];`, ...blocks].join("\n");
};

const syncBody = (children: WireChild[], indent: string): string =>
  children
    .map(
      (c) => `${indent}if (array_key_exists('${c.relation}', $children)) {
${indent}${UNIT}$m->${c.relation}()->delete();
${indent}${UNIT}$m->${c.relation}()->createMany($children['${c.relation}']);
${indent}}`,
    )
    .join("\n");

// `self::has` is only ever called from `fromWireChildStatements`, so a childless shape
// (no `self::has` call site) omits it rather than leave an unused private method.
const hasHelper = `

    private static function has(array $a, array $path): bool
    {
        $cur = $a;
        foreach ($path as $seg) {
            if (! is_array($cur) || ! array_key_exists($seg, $cur)) {
                return false;
            }
            $cur = $cur[$seg];
        }

        return true;
    }`;

const fieldEntry = (s: WireScalar, indent: string): string =>
  `${indent}'${s.key.join(".")}' => ['column' => '${s.column}', 'type' => '${s.type}'],`;

const relationEntry = (r: WireRelation, indent: string): string =>
  `${indent}'${r.key}' => ['relation' => '${r.relation}', 'kind' => '${r.kind}', 'model' => \\App\\Models\\${r.model}::class, 'serializer' => ${r.model}Serializer::class, 'foreignKey' => ${r.foreignKey === null ? "null" : `'${r.foreignKey}'`}, 'uid' => '${r.uid}', 'holder' => '${r.holder}', 'draftPublish' => ${r.draftPublish}, 'localized' => ${r.localized}],`;

/**
 * The wire path → column map `App\Support\StrapiQuery` filters, sorts and selects by: every
 * scalar Strapi exposes (`id`, `documentId`, the timestamps, embedded component scalars as dotted
 * paths), each repeatable component as its child relation with the child's own map, and each
 * relation as its Eloquent relation, target and storage.
 */
const fieldsConstant = (shape: WireShape): string => {
  const l2 = `${UNIT}${UNIT}`;
  const l3 = `${l2}${UNIT}`;
  const id: WireScalar = { key: ["id"], column: "id", type: "integer" };
  const documentId: WireScalar = { key: ["documentId"], column: "document_id", type: "string" };
  const timestamps: WireScalar[] = [
    { key: ["createdAt"], column: "created_at", type: "dateTime" },
    { key: ["updatedAt"], column: "updated_at", type: "dateTime" },
    ...(shape.draftPublish
      ? [{ key: ["publishedAt"], column: "published_at", type: "dateTime" as const }]
      : []),
    ...(shape.localized ? [{ key: ["locale"], column: "locale", type: "string" as const }] : []),
  ];
  const children = shape.children.map(
    (c) =>
      `${l2}'${c.key.join(".")}' => ['component' => '${c.relation}', 'fields' => [\n${c.scalars.map((s) => fieldEntry(s, l3)).join("\n")}\n${l2}]],`,
  );
  const rows = [
    ...[id, documentId, ...shape.scalars].map((s) => fieldEntry(s, l2)),
    ...children,
    ...shape.relations.map((r) => relationEntry(r, l2)),
    ...timestamps.map((s) => fieldEntry(s, l2)),
  ];
  const components = shape.components.map((c) => `'${c}'`).join(", ");
  return `\n    /** Wire path → column, for StrapiQuery's filters, sort and fields. */\n    public const FIELDS = [\n${rows.join("\n")}\n    ];\n\n    /** Component keys, which Strapi leaves off the wire unless populate names them. */\n    public const COMPONENTS = [${components}];\n\n    /** Whether each document has a draft and, once published, a published version. */\n    public const DRAFT_PUBLISH = ${shape.draftPublish};\n\n    /** Whether each document keeps one row per locale. */\n    public const LOCALIZED = ${shape.localized};\n`;
};

export const emitSerializer = (shape: WireShape, layout: StorageLayout = "laravel"): string => {
  const l2 = `${UNIT}${UNIT}`; // method-body statements
  const l3 = `${UNIT}${UNIT}${UNIT}`; // array literal entries
  const syncChildrenBody = shape.children.length === 0 ? "" : `\n${syncBody(shape.children, l2)}`;
  const hasHelperBody = shape.children.length === 0 ? "" : hasHelper;
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Serializers;

use App\\Models\\${shape.model};

final class ${shape.model}Serializer
{${layout === "laravel" ? fieldsConstant(shape) : ""}
    /** Strapi-shaped wire object: camelCase keys, nested components, nulls omitted${shape.draftPublish ? " (but publishedAt, null on a draft)" : ""}. */
    public static function toWire(${shape.model} $m): array
    {
        return self::omitNulls([
${toWireBody(shape, l3, layout)}
        ])${shape.draftPublish && layout === "laravel" ? ` + [\n${l3}'publishedAt' => $m->published_at${ZULU_MS},\n        ]` : ""};
    }

    /** Inverse of toWire: ['columns' => [...], 'children' => [relation => list<row>]]. Unknown keys ignored. */
    public static function fromWire(array $data): array
    {
        $columns = array_filter([
${fromWireColumns(shape.scalars, "$data", l3)}
        ], fn ($v) => $v !== null);
${fromWireChildStatements(shape.children, l2)}

        return ['columns' => $columns, 'children' => $children];
    }

    public static function syncChildren(${shape.model} $m, array $children): void
    {${syncChildrenBody}
    }

    private static function omitNulls(array $a): array
    {
        return array_filter($a, fn ($v) => $v !== null);
    }

    /** Like omitNulls, but an all-null result collapses to null so the parent array drops the key. */
    private static function nested(array $a): ?array
    {
        $a = self::omitNulls($a);

        return $a === [] ? null : $a;
    }

    private static function dig(array $a, array $path): mixed
    {
        $cur = $a;
        foreach ($path as $seg) {
            if (! is_array($cur) || ! array_key_exists($seg, $cur)) {
                return null;
            }
            $cur = $cur[$seg];
        }

        return $cur;
    }${hasHelperBody}
}
`;
};
