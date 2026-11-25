import type { StorageLayout } from "@camis/adapter-kernel";
import { PHP_MARKER } from "../../hooks/names";
import { itemsLinkAnything } from "./items-runtime";
import { morphEntry } from "./morphs";
import type {
  WireChild,
  WireRelation,
  WireScalar,
  WireShape,
  WireZone,
  WireZoneMember,
} from "./wire-shape";

const NUMERIC_INT = new Set(["integer"]);
// Strapi renders a `biginteger` as a string: a 64-bit value does not survive a JSON number.
const NUMERIC_STRING = new Set(["bigInteger"]);
const NUMERIC_FLOAT = new Set(["float", "decimal"]);
const DATETIME = new Set(["dateTime"]);
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
  // Strapi renders a decimal as a number, but a JSON number holding more digits than a double
  // keeps is rounded by every JavaScript client: such a decimal is a string, as its cast reads it.
  if (NUMERIC_STRING.has(s.type) || s.exact === true)
    return `${col} === null ? null : (string) ${col}`;
  if (NUMERIC_FLOAT.has(s.type)) return `${col} === null ? null : (float) ${col}`;
  if (DATE_ONLY.has(s.type)) return layout === "strapi" ? col : `${col}?->toDateString()`;
  if (DATETIME.has(s.type)) return `${col}${ZULU_MS}`;
  // Strapi sends a timestamp as its epoch in milliseconds, as a string.
  if (s.type === "timestamp") return `${col} === null ? null : (string) ${col}->getTimestampMs()`;
  return col;
};

// A component's files, whole: populate leaves them off, or narrows them, as it does an entry's.
// `$src` is the row holding the component: an item's own, or the entry's for an embedded one.
const mediaWire = (r: WireRelation, src = "$c"): string =>
  r.kind === "mediaMany"
    ? `${src}->${r.relation}()->orderByPivot('order')->get()->map(fn ($f) => ${r.model}Serializer::toWire($f))->all()`
    : `${src}->${r.relation}->first() === null ? null : ${r.model}Serializer::toWire(${src}->${r.relation}->first())`;

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
// `self::nested(...)` for branches: a component stored as all-null columns has no value, so it is
// null, as Strapi sends an unset component, not `[]` (a JSON array) or an object of nulls.
const render = (n: Node, indent: string): string => {
  const rows: string[] = [];
  for (const [k, v] of n.leaves) rows.push(`${indent}'${k}' => ${v},`);
  for (const [k, b] of n.branches)
    rows.push(`${indent}'${k}' => self::nested([\n${render(b, `${indent}${UNIT}`)}\n${indent}]),`);
  return rows.join("\n");
};

/**
 * Strapi gives every component an id. An embedded one is columns of the row holding it (the entry,
 * or a repeatable or zone item), so it goes by that row's id, set before its fields so it leads.
 */
const insertComponentIds = (n: Node, keys: readonly (readonly string[])[], id: string): void => {
  for (const key of keys)
    for (let depth = 1; depth < key.length; depth++) insert(n, [...key.slice(0, depth), "id"], id);
};

/** The scalars an answer carries: every one but the private, which are only written. */
const answered = (scalars: WireScalar[]): WireScalar[] => scalars.filter((s) => s.private !== true);

/**
 * A repeatable's items, read from `src`'s relation: each item's id, its columns, its files and the
 * items of the repeatables inside it, which `render` nests one level deeper per item. `level` names
 * the item's variable (`$c`, `$c2`, ...), so an item nested in another still reaches its own row.
 */
const childWire = (
  c: WireChild,
  src: string,
  level: number,
  indent: string,
  layout: StorageLayout,
): string => {
  const item = level === 1 ? "$c" : `$c${level}`;
  const inner = node();
  insert(inner, ["id"], `${item}->id`);
  const nested = c.children.filter((n) => n.private !== true);
  insertComponentIds(
    inner,
    [
      ...answered(c.scalars).map((s) => s.key),
      ...c.media.map((r) => r.key.split(".")),
      ...nested.map((n) => n.key),
    ],
    `${item}->id`,
  );
  for (const s of answered(c.scalars)) insert(inner, s.key, read(s, item, layout));
  for (const r of c.media) insert(inner, r.key.split("."), mediaWire(r, item));
  // The child's own row is rendered by `render` one branch level per path segment above
  // it (depth = c.key.length - 1), matching how it indents a nested `self::nested([`
  // branch body — so the map's rows sit a further level in, and its closing
  // `]))...` aligns with the row it hangs off, not with the toplevel `indent`.
  const depth = c.key.length;
  const rowIndent = `${indent}${UNIT.repeat(depth)}`;
  const closeIndent = `${indent}${UNIT.repeat(depth - 1)}`;
  for (const n of nested) insert(inner, n.key, childWire(n, item, level + 1, rowIndent, layout));
  return `${src}->${c.relation}->map(fn (${item}) => [\n${render(inner, rowIndent)}\n${closeIndent}])->all()`;
};

const toWireBody = (shape: WireShape, indent: string, layout: StorageLayout): string => {
  const root = node();
  insert(root, ["id"], "$m->id");
  insert(root, ["documentId"], "$m->document_id");
  const own = answered(shape.scalars);
  const children = shape.children.filter((c) => c.private !== true);
  const files = shape.embeddedMedia.filter((r) => r.private !== true);
  insertComponentIds(
    root,
    [
      ...own.map((s) => s.key),
      ...children.map((c) => c.key),
      ...files.map((r) => r.key.split(".")),
    ],
    "$m->id",
  );
  for (const s of own) insert(root, s.key, read(s, "$m", layout));
  for (const r of files) insert(root, r.key.split("."), mediaWire(r, "$m"));
  for (const c of children) insert(root, c.key, childWire(c, "$m", 1, indent, layout));
  if (layout === "laravel")
    for (const z of shape.zones) insert(root, [z.key], zoneWire(z, `${indent}${UNIT}`));
  insert(root, ["createdAt"], `$m->created_at${ZULU_MS}`);
  insert(root, ["updatedAt"], `$m->updated_at${ZULU_MS}`);
  // Strapi stamps publishedAt on every write of a type without draft and publish.
  if (!shape.draftPublish && layout === "laravel")
    insert(root, ["publishedAt"], `$m->updated_at${ZULU_MS}`);
  if (shape.localized && layout === "laravel") insert(root, ["locale"], "$m->locale");
  return render(root, indent);
};

// One member's items as [position, wire item] pairs, which `self::zone` puts back in the zone's order.
const zoneMemberWire = (member: WireZoneMember, indent: string): string => {
  const item = node();
  insert(item, ["__component"], `'${member.uid}'`);
  insert(item, ["id"], "$c->id");
  insertComponentIds(
    item,
    [
      ...answered(member.scalars).map((s) => s.key),
      ...member.media.map((r) => r.key.split(".")),
      ...member.children.map((n) => n.key),
    ],
    "$c->id",
  );
  for (const s of answered(member.scalars)) insert(item, s.key, read(s, "$c", "laravel"));
  for (const r of member.media) insert(item, r.key.split("."), mediaWire(r));
  for (const n of member.children)
    insert(item, n.key, childWire(n, "$c", 2, `${indent}${UNIT}`, "laravel"));
  return `${indent}...$m->${member.relation}->map(fn ($c) => [$c->position, [
${render(item, `${indent}${UNIT}`)}
${indent}]])->all(),`;
};

const zoneWire = (zone: WireZone, indent: string): string =>
  `self::zone([\n${zone.members.map((m) => zoneMemberWire(m, indent)).join("\n")}\n${indent.slice(UNIT.length)}])`;

const quoted = (keys: readonly string[]): string => keys.map((k) => `'${k}'`).join(", ");

const takenValue = (s: WireScalar, src: string, at: string): string => {
  const value = `self::dig(${src}, [${quoted(s.key)}])`;
  return s.type === "timestamp"
    ? `self::epoch(${value})`
    : s.digits !== undefined
      ? `self::decimal(${value}, ${s.digits.precision}, ${s.digits.scale}, [${at}${quoted(s.key)}])`
      : value;
};

/**
 * Each column of a row read from `src`. `at` is the PHP list of the path to `src` within the
 * request (a repeatable's key and an item's index, say), which a refused decimal names.
 */
const fromWireColumns = (scalars: WireScalar[], src: string, indent: string, at = ""): string =>
  scalars.map((s) => `${indent}'${s.column}' => ${takenValue(s, src, at)},`).join("\n");

/**
 * The entry's own columns, each set only when the payload names its key: an explicit null clears
 * the column, as Strapi does, and a missing key leaves it. Items are not read this way, as their
 * rows are written afresh and a null is no value in one.
 */
const fromWireEntryColumns = (scalars: WireScalar[], indent: string): string =>
  scalars
    .map(
      (s) =>
        `${indent}if (self::given($data, [${quoted(s.key)}])) {\n${indent}${UNIT}$columns['${s.column}'] = ${takenValue(s, "$data", "")};\n${indent}}`,
    )
    .join("\n");

// Each child key is set only when the wire payload names it, mirroring `syncChildren`'s
// `array_key_exists` guard: an absent key leaves existing rows untouched, an explicit `[]`
// clears them. A single unconditional entry (falling back to `[]`) would collapse that
// distinction and make every `fromWire` call wipe children the client never mentioned. A null
// component names the repeatables inside it, whose items `self::dig` then reads as none.
const fromWireChildStatements = (children: WireChild[], indent: string): string => {
  if (children.length === 0) return `${indent}$children = [];`;
  const blocks = children.map((c) => {
    const assignIndent = `${indent}${UNIT}`;
    const path = c.key.map((k) => `'${k}'`).join(", ");
    return `${indent}if (self::given($data, [${path}])) {
${assignIndent}$children['${c.relation}'] = ${itemRows(c, `self::dig($data, [${path}])`, 1, assignIndent, `${path}, `)};
${indent}}`;
  });
  return [`${indent}$children = [];`, ...blocks].join("\n");
};

/**
 * A repeatable's items as sent, as rows: each item's columns, its links as sent (`__links`: its
 * files and relations, which the controller resolves before anything is written) and the rows of
 * the repeatables inside it (`__children`). A new item links nothing and holds no items, so a null
 * reference or list and a missing one mean the same.
 */
const itemRows = (
  c: WireChild,
  value: string,
  level: number,
  indent: string,
  at: string,
): string => {
  const row = level === 1 ? "$row" : `$row${level}`;
  // An item's index is read only where a decimal in it, which a refusal names by it, needs it.
  const index = statesDigits(c) ? (level === 1 ? "$i" : `$i${level}`) : undefined;
  const itemAt = index === undefined ? "" : `${at}(string) ${index}, `;
  const rowIndent = `${indent}${UNIT}`;
  const links = [...c.media, ...c.relations];
  const nested = c.children.map(
    (n) =>
      `${rowIndent}${UNIT}'${n.relation}' => ${itemRows(n, `self::dig(${row}, [${quoted(n.key)}])`, level + 1, `${rowIndent}${UNIT}`, `${itemAt}${quoted(n.key)}, `)},`,
  );
  const parts = [
    fromWireColumns(c.scalars, row, rowIndent, itemAt),
    ...(links.length === 0 ? [] : [fromWireLinks(links, row, rowIndent)]),
    ...(nested.length === 0
      ? []
      : [`${rowIndent}'__children' => [\n${nested.join("\n")}\n${rowIndent}],`]),
  ].filter((part) => part !== "");
  const items = `is_array(${value}) ? ${value} : []`;
  return index === undefined
    ? `array_map(fn (array ${row}) => array_filter([
${parts.join("\n")}
${indent}], fn ($v) => $v !== null), ${items})`
    : `array_map(fn (array ${row}, int|string ${index}) => array_filter([
${parts.join("\n")}
${indent}], fn ($v) => $v !== null), ${items}, array_keys(${items}))`;
};

/** Whether an item, or an item of a repeatable inside it, writes a decimal stating its digits. */
const statesDigits = (c: Pick<WireChild, "scalars" | "children">): boolean =>
  c.scalars.some((s) => s.digits !== undefined) || c.children.some(statesDigits);

// An item's links as sent: the controller resolves them before any write.
const fromWireLinks = (links: WireRelation[], row: string, indent: string): string =>
  `${indent}'__links' => array_filter([\n${links
    .map(
      (r) =>
        `${indent}${UNIT}'${r.key}' => self::dig(${row}, [${r.key
          .split(".")
          .map((k) => `'${k}'`)
          .join(", ")}]),`,
    )
    .join("\n")}\n${indent}], fn ($v) => $v !== null),`;

// A zone's items, refused or dropped as Strapi does by `StrapiZones::items`, each member's columns
// read from its item. Set only when the payload mentions the zone, like the children above.
const fromWireZoneStatements = (zones: WireZone[], indent: string): string =>
  zones
    .map((z) => {
      const l1 = `${indent}${UNIT}`;
      const l2 = `${l1}${UNIT}`;
      const l3 = `${l2}${UNIT}`;
      // StrapiZones passes an item's place in the zone, which a refused decimal in it names.
      const positioned = z.members.some(statesDigits);
      const at = positioned ? `'${z.key}', (string) $position, ` : "";
      const arms = z.members
        .map(
          (m) =>
            `${l2}'${m.uid}' => [\n${[
              fromWireColumns(m.scalars, "$item", l3, at),
              ...(m.media.length + m.relations.length === 0
                ? []
                : [zoneItemLinks([...m.media, ...m.relations], l3)]),
              ...(m.children.length === 0 ? [] : [zoneItemChildren(m.children, l3, at)]),
            ]
              .filter((part) => part !== "")
              .join("\n")}\n${l2}],`,
        )
        .join("\n");
      return `${indent}if (array_key_exists('${z.key}', $data)) {
${l1}$children['${z.key}'] = StrapiZones::items($data['${z.key}'], '${z.key}', self::ZONES['${z.key}'], fn (string $uid, array $item${positioned ? ", int $position" : ""}) => match ($uid) {
${arms}
${l1}});
${indent}}`;
    })
    .join("\n");

// An item's links as sent, null included: an item kept by its id keeps what it leaves out.
// The controller resolves them to links before anything is written.
const zoneItemLinks = (links: WireRelation[], indent: string): string =>
  `${indent}'__links' => array_intersect_key($item, [${[...new Set(links.map((r) => r.key.split(".")[0]))].map((k) => `'${k}' => true`).join(", ")}]),`;

// The items of the repeatables inside a zone's item, replaced whole with the item.
const zoneItemChildren = (children: WireChild[], indent: string, at: string): string =>
  `${indent}'__children' => array_filter([\n${children
    .map(
      (n) =>
        `${indent}${UNIT}'${n.relation}' => self::has($item, [${n.key.map((k) => `'${k}'`).join(", ")}]) ? ${itemRows(n, `self::dig($item, [${quoted(n.key)}])`, 2, `${indent}${UNIT}`, `${at}${quoted(n.key)}, `)} : null,`,
    )
    .join("\n")}\n${indent}], fn ($v) => $v !== null),`;

const zoneSyncBody = (zones: WireZone[], indent: string): string =>
  zones
    .map(
      (z) => `${indent}if (array_key_exists('${z.key}', $children)) {
${indent}${UNIT}StrapiZones::sync($m, '${z.key}', self::ZONES['${z.key}'], $children['${z.key}']);
${indent}}`,
    )
    .join("\n");

const zoneEntry = (zone: WireZone, indent: string): string =>
  `${indent}'${zone.key}' => [\n${zone.members
    .map((m) => {
      const l2 = `${indent}${UNIT}`;
      const l3 = `${l2}${UNIT}`;
      const head = `${l2}'${m.uid}' => ['relation' => '${m.relation}', 'components' => [${m.components.map((c) => `'${c}'`).join(", ")}]`;
      const parts = [
        ...(m.media.length === 0
          ? []
          : [`'fields' => [\n${m.media.map((r) => relationEntry(r, l3)).join("\n")}\n${l2}]`]),
        ...(m.relations.length === 0
          ? []
          : [`'links' => [\n${m.relations.map((r) => relationEntry(r, l3)).join("\n")}\n${l2}]`]),
        ...(m.children.length === 0
          ? []
          : [`'children' => [\n${m.children.map((n) => childEntry(n, l3)).join("\n")}\n${l2}]`]),
      ];
      return parts.length === 0 ? `${head}],` : `${head}, ${parts.join(", ")}],`;
    })
    .join("\n")}\n${indent}],`;

const zoneHelper = `

    /** @param list<array{0: int, 1: array}> $items [position, item] pairs from every member */
    private static function zone(array $items): array
    {
        usort($items, fn (array $a, array $b) => $a[0] <=> $b[0]);

        return array_column($items, 1);
    }`;

// Items that link files, or hold items that do, are deleted one by one, so their links go with
// them; items that link anything or hold items are made one by one (`StrapiItems`).
const syncBody = (children: WireChild[], indent: string): string =>
  children
    .map((c) =>
      !itemsLinkAnything(c)
        ? `${indent}if (array_key_exists('${c.relation}', $children)) {
${indent}${UNIT}$m->${c.relation}()->delete();
${indent}${UNIT}$m->${c.relation}()->createMany($children['${c.relation}']);
${indent}}`
        : `${indent}if (array_key_exists('${c.relation}', $children)) {
${indent}${UNIT}StrapiItems::replace($m->${c.relation}(), $children['${c.relation}'], ${linksFiles(c)});
${indent}}`,
    )
    .join("\n");

/** Whether an item, or an item nested in it, links a file: its rows go one by one, links and all. */
const linksFiles = (c: WireChild): boolean => c.media.length > 0 || c.children.some(linksFiles);

// Whether a zone's item holds a path. Unlike `given`, a null component holds nothing: a zone's
// item kept by its id keeps the columns it sends as null, so it keeps the items below them too.
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

// Whether the payload names a path. A null where a component sits names every field inside it,
// which clears the component as Strapi does; a key that is missing names nothing.
const givenHelper = `

    private static function given(array $a, array $path): bool
    {
        $cur = $a;
        foreach ($path as $seg) {
            if ($cur === null) {
                return true;
            }
            if (! is_array($cur) || ! array_key_exists($seg, $cur)) {
                return false;
            }
            $cur = $cur[$seg];
        }

        return true;
    }`;

// Emitted only for a shape writing a decimal stating its digits. SQLite keeps one beyond a PHP
// float as text, which takes any string: every value is kept as MySQL and PostgreSQL keep it, at
// its scale, and one that is not a decimal or does not fit is refused before it is written.
const decimalHelper = `

    /** A decimal stating its digits as its column keeps it, from a string or a number; refused, named by its path, when it is not one that fits. */
    private static function decimal(mixed $value, int $precision, int $scale, array $path): ?string
    {
        if ($value === null) {
            return null;
        }
        $decimal = DecimalDigits::canonical($value, $precision, $scale);
        if ($decimal === null) {
            // StrapiValidator's form: ['entries', '1', 'amount'] reads entries[1].amount.
            $label = '';
            foreach ($path as $segment) {
                $label .= ctype_digit($segment) ? "[{$segment}]" : ($label === '' ? $segment : ".{$segment}");
            }
            $message = "{$label} must be a decimal of at most {$precision} digits, {$scale} of them after the point";

            throw StrapiError::validation($message, ['errors' => [['path' => $path, 'message' => $message, 'name' => 'ValidationError']]]);
        }

        return $decimal;
    }`;

// Emitted only for a shape with a timestamp scalar, so no other serializer carries it unused.
const epochHelper = `

    /** A timestamp as Strapi takes one: its epoch in milliseconds, or a date string. */
    private static function epoch(mixed $value): mixed
    {
        return is_int($value) || is_float($value) || (is_string($value) && ctype_digit($value))
            ? \\Carbon\\CarbonImmutable::createFromTimestampMsUTC((float) $value)
            : $value;
    }`;

const hasTimestamp = (shape: WireShape, zones: WireZone[]): boolean =>
  [
    ...shape.scalars,
    ...shape.children.flatMap((c) => c.scalars),
    ...zones.flatMap((z) => z.members.flatMap((m) => m.scalars)),
  ].some((s) => s.type === "timestamp");

/** Whether fromWire writes a scalar that `which` picks: the entry's, an item's at any depth, a zone member's. */
const writesScalar = (
  shape: WireShape,
  zones: WireZone[],
  which: (s: WireScalar) => boolean,
): boolean => {
  const items = (children: readonly WireChild[]): WireScalar[] =>
    children.flatMap((c) => [...c.scalars, ...items(c.children)]);
  return [
    ...shape.scalars,
    ...items(shape.children),
    ...zones.flatMap((z) => z.members.flatMap((m) => [...m.scalars, ...items(m.children)])),
  ].some(which);
};

/** Whether a zone's item writes a decimal stating its digits, whose refusal names its place. */
export const zoneItemsStateDigits = (shape: WireShape): boolean =>
  shape.zones.some((z) => z.members.some(statesDigits));

/** Whether a shape writes or filters a decimal stating its digits, at any depth. */
export const statesDecimalDigits = (shape: WireShape): boolean =>
  writesScalar(shape, shape.zones, (s) => s.digits !== undefined);

const privateEntry = (entry: { private?: true }): string =>
  entry.private === true ? ", 'private' => true" : "";

// A decimal stating its digits carries them, by which StrapiQuery compares a filter's value.
const scaleEntry = (s: WireScalar): string =>
  s.digits === undefined
    ? ""
    : `, 'precision' => ${s.digits.precision}, 'scale' => ${s.digits.scale}`;

const fieldEntry = (s: WireScalar, indent: string): string =>
  `${indent}'${s.key.join(".")}' => ['column' => '${s.column}', 'type' => '${s.type}'${scaleEntry(s)}${privateEntry(s)}],`;

const column = (c: string | null | undefined): string => (c == null ? "null" : `'${c}'`);

const relationEntry = (r: WireRelation, indent: string): string =>
  `${indent}'${r.key}' => ['relation' => '${r.relation}', 'kind' => '${r.kind}', 'model' => \\App\\Models\\${r.model}::class, 'serializer' => ${r.model}Serializer::class, 'foreignKey' => ${column(r.foreignKey)}, 'uid' => '${r.uid}', 'holder' => '${r.holder}', 'draftPublish' => ${r.draftPublish}, 'localized' => ${r.localized}, 'order' => ${column(r.order?.column)}, 'inverseOrder' => ${column(r.inverseOrder?.column)}${r.readOnly === true ? ", 'readOnly' => true" : ""}${privateEntry(r)}],`;

/**
 * A repeatable's entry: its child relation and its items' own map, keyed relative to the item: the
 * item's columns, its files and relations, and the repeatables inside it, each an entry like this.
 */
const childEntry = (c: WireChild, indent: string): string =>
  `${indent}'${c.key.join(".")}' => ['component' => '${c.relation}', 'fields' => [\n${[
    ...c.scalars.map((s) => fieldEntry(s, `${indent}${UNIT}`)),
    ...c.media.map((r) => relationEntry(r, `${indent}${UNIT}`)),
    ...c.relations.map((r) => relationEntry(r, `${indent}${UNIT}`)),
    ...c.children.map((n) => childEntry(n, `${indent}${UNIT}`)),
  ].join("\n")}\n${indent}]${privateEntry(c)}],`;

/**
 * The wire path → column map `App\Support\StrapiQuery` filters, sorts and selects by: every
 * scalar Strapi exposes (`id`, `documentId`, the timestamps, embedded component scalars as dotted
 * paths), each repeatable component as its child relation with the child's own map, and each
 * relation as its Eloquent relation, target and storage, and each dynamic zone as a key that
 * is none of these.
 */
const fieldsConstant = (shape: WireShape): string => {
  const l2 = `${UNIT}${UNIT}`;
  const id: WireScalar = { key: ["id"], column: "id", type: "integer" };
  const documentId: WireScalar = { key: ["documentId"], column: "document_id", type: "string" };
  const timestamps: WireScalar[] = [
    { key: ["createdAt"], column: "created_at", type: "dateTime" },
    { key: ["updatedAt"], column: "updated_at", type: "dateTime" },
    {
      key: ["publishedAt"],
      column: shape.draftPublish ? "published_at" : "updated_at",
      type: "dateTime",
    },
    ...(shape.localized ? [{ key: ["locale"], column: "locale", type: "string" as const }] : []),
  ];
  const children = shape.children.map((c) => childEntry(c, l2));
  const rows = [
    ...[id, documentId, ...shape.scalars].map((s) => fieldEntry(s, l2)),
    ...shape.embeddedMedia.map((r) => relationEntry(r, l2)),
    ...shape.embeddedRelations.map((r) => relationEntry(r, l2)),
    ...children,
    // A zone is a key Strapi knows but will not filter, sort or select by.
    ...shape.zones.map((z) => `${l2}'${z.key}' => ['zone' => true],`),
    ...shape.relations.map((r) => relationEntry(r, l2)),
    ...(shape.morphs ?? []).map((m) => morphEntry(m, l2)),
    ...(shape.morphInverses ?? []).map((r) => relationEntry(r, l2)),
    ...timestamps.map((s) => fieldEntry(s, l2)),
  ];
  const components = shape.components.map((c) => `'${c}'`).join(", ");
  const zones =
    shape.zones.length === 0
      ? "[]"
      : `[\n${shape.zones.map((z) => zoneEntry(z, l2)).join("\n")}\n    ]`;
  return `\n    /** Wire path → column, for StrapiQuery's filters, sort and fields. */\n    public const FIELDS = [\n${rows.join("\n")}\n    ];\n\n    /** Component keys, which Strapi leaves off the wire unless populate names them. */\n    public const COMPONENTS = [${components}];\n\n    /** Each dynamic zone's member components by uid: the child relation its items live in, its own component keys, its media fields, its relations and its repeatables. */\n    public const ZONES = ${zones};\n\n    /** Whether each document has a draft and, once published, a published version. */\n    public const DRAFT_PUBLISH = ${shape.draftPublish};\n\n    /** Whether each document keeps one row per locale. */\n    public const LOCALIZED = ${shape.localized};\n`;
};

export const emitSerializer = (shape: WireShape, layout: StorageLayout = "laravel"): string => {
  const l2 = `${UNIT}${UNIT}`; // method-body statements
  const l3 = `${UNIT}${UNIT}${UNIT}`; // array literal entries
  const zones = layout === "laravel" ? shape.zones : [];
  const syncChildrenBody = [
    ...(shape.children.length === 0 ? [] : [syncBody(shape.children, l2)]),
    ...(zones.length === 0 ? [] : [zoneSyncBody(zones, l2)]),
  ]
    .map((body) => `\n${body}`)
    .join("");
  const givenHelperBody =
    shape.scalars.length === 0 && shape.children.length === 0 ? "" : givenHelper;
  const hasHelperBody = zones.some((z) => z.members.some((m) => m.children.length > 0))
    ? hasHelper
    : "";
  const zoneHelperBody = zones.length === 0 ? "" : zoneHelper;
  const epochHelperBody = hasTimestamp(shape, zones) ? epochHelper : "";
  const decimalHelperBody = writesScalar(shape, zones, (s) => s.digits !== undefined)
    ? decimalHelper
    : "";
  const zoneImport = [
    ...(decimalHelperBody === ""
      ? []
      : ["\nuse App\\Support\\DecimalDigits;", "\nuse App\\Support\\StrapiError;"]),
    ...(shape.children.some(itemsLinkAnything) ? ["\nuse App\\Support\\StrapiItems;"] : []),
    ...(zones.length === 0 ? [] : ["\nuse App\\Support\\StrapiZones;"]),
  ].join("");
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Serializers;

use App\\Models\\${shape.model};${zoneImport}

final class ${shape.model}Serializer
{${layout === "laravel" ? fieldsConstant(shape) : ""}
    /** Strapi-shaped wire object: camelCase keys, nested components, null where there is no value. */
    public static function toWire(${shape.model} $m): array
    {
        return [
${toWireBody(shape, l3, layout)}
        ]${shape.draftPublish && layout === "laravel" ? ` + [\n${l3}'publishedAt' => $m->published_at${ZULU_MS},\n        ]` : ""};
    }

    /** Inverse of toWire: ['columns' => [...], 'children' => [relation => list<row>]]. Unknown keys ignored. */
    public static function fromWire(array $data): array
    {
        $columns = [];
${fromWireEntryColumns(shape.scalars, l2)}
${fromWireChildStatements(shape.children, l2)}${zones.length === 0 ? "" : `\n${fromWireZoneStatements(zones, l2)}`}

        return ['columns' => $columns, 'children' => $children];
    }

    public static function syncChildren(${shape.model} $m, array $children): void
    {${syncChildrenBody}
    }

    /** A component's fields, or null when none has a value (its id, the row's, is not one, nor a repeatable or set of files with none). */
    private static function nested(array $a): ?array
    {
        return array_filter(array_diff_key($a, ['id' => true]), fn ($v) => $v !== null && $v !== []) === [] ? null : $a;
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
    }${givenHelperBody}${hasHelperBody}${zoneHelperBody}${epochHelperBody}${decimalHelperBody}
}
`;
};
