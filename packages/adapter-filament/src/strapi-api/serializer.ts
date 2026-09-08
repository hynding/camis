import { PHP_MARKER } from "../hooks/names";
import type { WireChild, WireScalar, WireShape } from "./wire-shape";

const NUMERIC_INT = new Set(["integer", "bigInteger"]);
const NUMERIC_FLOAT = new Set(["float", "decimal"]);
const DATETIME = new Set(["dateTime", "timestamp", "date"]);

// PHP expression producing the wire value for one column of `$src`.
const read = (s: WireScalar, src: string): string => {
  const col = `${src}->${s.column}`;
  if (NUMERIC_INT.has(s.type)) return `${col} === null ? null : (int) ${col}`;
  if (NUMERIC_FLOAT.has(s.type)) return `${col} === null ? null : (float) ${col}`;
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
const render = (n: Node, indent: string): string => {
  const rows: string[] = [];
  for (const [k, v] of n.leaves) rows.push(`${indent}'${k}' => ${v},`);
  for (const [k, b] of n.branches)
    rows.push(`${indent}'${k}' => self::omitNulls([\n${render(b, `${indent}    `)}\n${indent}]),`);
  return rows.join("\n");
};

const toWireBody = (shape: WireShape): string => {
  const root = node();
  insert(root, ["id"], "$m->id");
  for (const s of shape.scalars) insert(root, s.key, read(s, "$m"));
  for (const c of shape.children) {
    const inner = node();
    for (const s of c.scalars) insert(inner, s.key, read(s, "$c"));
    insert(
      root,
      [c.key],
      `$m->${c.relation}->map(fn ($c) => self::omitNulls([\n${render(inner, "            ")}\n        ]))->values()->all()`,
    );
  }
  insert(root, ["createdAt"], "$m->created_at?->toJSON()");
  insert(root, ["updatedAt"], "$m->updated_at?->toJSON()");
  return render(root, "            ");
};

const fromWireColumns = (scalars: WireScalar[], src: string): string =>
  scalars
    .map(
      (s) =>
        `            '${s.column}' => self::dig(${src}, [${s.key.map((k) => `'${k}'`).join(", ")}]),`,
    )
    .join("\n");

const fromWireChildren = (children: WireChild[]): string =>
  children
    .map(
      (c) => `            '${c.relation}' => array_map(fn (array $row) => array_filter([
${fromWireColumns(c.scalars, "$row")}
            ], fn ($v) => $v !== null), is_array($data['${c.key}'] ?? null) ? $data['${c.key}'] : []),`,
    )
    .join("\n");

const syncBody = (children: WireChild[]): string =>
  children
    .map(
      (c) => `        if (array_key_exists('${c.relation}', $children)) {
            $m->${c.relation}()->delete();
            $m->${c.relation}()->createMany($children['${c.relation}']);
        }`,
    )
    .join("\n");

export const emitSerializer = (shape: WireShape): string => `<?php
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
${toWireBody(shape)}
        ]);
    }

    /** Inverse of toWire: ['columns' => [...], 'children' => [relation => list<row>]]. Unknown keys ignored. */
    public static function fromWire(array $data): array
    {
        $columns = array_filter([
${fromWireColumns(shape.scalars, "$data")}
        ], fn ($v) => $v !== null);
        $children = [
${fromWireChildren(shape.children)}
        ];

        return ['columns' => $columns, 'children' => $children];
    }

    public static function syncChildren(${shape.model} $m, array $children): void
    {
${syncBody(shape.children)}
    }

    private static function omitNulls(array $a): array
    {
        return array_filter($a, fn ($v) => $v !== null);
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
