import { PHP_MARKER } from "../hooks/names";
import type { WireChild, WireScalar, WireShape } from "./wire-shape";

const NUMERIC_INT = new Set(["integer", "bigInteger"]);
const NUMERIC_FLOAT = new Set(["float", "decimal"]);
const DATETIME = new Set(["dateTime", "timestamp"]);
// Strapi renders a `date` attribute as YYYY-MM-DD; toJSON() would append a fabricated time.
const DATE_ONLY = new Set(["date"]);

// One PSR-12 indent level.
const UNIT = "    ";

// PHP expression producing the wire value for one column of `$src`.
const read = (s: WireScalar, src: string): string => {
  const col = `${src}->${s.column}`;
  if (NUMERIC_INT.has(s.type)) return `${col} === null ? null : (int) ${col}`;
  if (NUMERIC_FLOAT.has(s.type)) return `${col} === null ? null : (float) ${col}`;
  if (DATE_ONLY.has(s.type)) return `${col}?->toDateString()`;
  if (DATETIME.has(s.type)) return `${col}?->toJSON()`;
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

const toWireBody = (shape: WireShape, indent: string): string => {
  const root = node();
  insert(root, ["id"], "$m->id");
  for (const s of shape.scalars) insert(root, s.key, read(s, "$m"));
  for (const c of shape.children) {
    const inner = node();
    for (const s of c.scalars) insert(inner, s.key, read(s, "$c"));
    const rowIndent = `${indent}${UNIT}`;
    // Drop an all-null row from the list (self::nested → null) rather than emit `[]` for it.
    insert(
      root,
      [c.key],
      `$m->${c.relation}->map(fn ($c) => self::nested([\n${render(inner, rowIndent)}\n${indent}]))->filter(fn ($r) => $r !== null)->values()->all()`,
    );
  }
  insert(root, ["createdAt"], "$m->created_at?->toJSON()");
  insert(root, ["updatedAt"], "$m->updated_at?->toJSON()");
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
    return `${indent}if (array_key_exists('${c.key}', $data)) {
${assignIndent}$children['${c.relation}'] = array_map(fn (array $row) => array_filter([
${fromWireColumns(c.scalars, "$row", rowIndent)}
${assignIndent}], fn ($v) => $v !== null), is_array($data['${c.key}']) ? $data['${c.key}'] : []);
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

export const emitSerializer = (shape: WireShape): string => {
  const l2 = `${UNIT}${UNIT}`; // method-body statements
  const l3 = `${UNIT}${UNIT}${UNIT}`; // array literal entries
  const syncChildrenBody = shape.children.length === 0 ? "" : `\n${syncBody(shape.children, l2)}`;
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Serializers;

use App\\Models\\${shape.model};

final class ${shape.model}Serializer
{
    /** Strapi-shaped wire object: camelCase keys, nested components, nulls omitted. */
    public static function toWire(${shape.model} $m): array
    {
        return self::omitNulls([
${toWireBody(shape, l3)}
        ]);
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
    }
}
`;
};
