import { PHP_MARKER } from "../hooks/names";

const header = `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n`;

/**
 * Strapi 5's dynamic zones over one child table per member component, each row keeping its place
 * in the zone. A write names an item's component by uid: one the project lacks is refused with
 * Strapi's message, which names every component the project has; one the zone does not hold is
 * dropped, as Strapi drops it. An item may name the id of one the entry already holds, which keeps
 * it; any other id is refused (`dynamic-zone-vectors.json`, recorded from strapi-php). The admin's
 * Builder reads and writes the same rows.
 *
 * $members is a serializer's `ZONES[zone]`: uid → ['relation' => ..., 'components' => [...]],
 * 'fields' => its media fields and 'links' => its relations, which an item's row links through
 * `StrapiRelations` once written, and 'children' => the repeatables inside it (`StrapiItems`).
 */
export const emitStrapiZones = (componentUids: readonly string[]): string =>
  header +
  String.raw`
use Closure;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Arr;
use Illuminate\Support\Str;

final class StrapiZones
{
    /** Every component the project has, as Strapi lists them when an item names another. */
    private const COMPONENTS = [${componentUids.map((uid) => `'${uid}'`).join(", ")}];

    /**
     * A request's zone as each member relation's rows, in the zone's order. $columns reads one
     * item's columns for its component.
     *
     * @return array<string, list<array>>
     */
    public static function items(mixed $value, string $zone, array $members, Closure $columns): array
    {
        $rows = array_fill_keys(array_column($members, 'relation'), []);
        foreach (array_values(is_array($value) ? $value : []) as $position => $item) {
            $uid = is_array($item) ? ($item['__component'] ?? null) : null;
            if (! is_string($uid) || ! in_array($uid, self::COMPONENTS, true)) {
                throw StrapiError::validation("{$zone}[{$position}].__component must be one of the following values: " . implode(', ', self::COMPONENTS));
            }
            if (! isset($members[$uid])) {
                continue;
            }
            $row = ['position' => $position] + array_filter($columns($uid, $item), fn ($v) => $v !== null);
            if (isset($item['id'])) {
                $row['id'] = $item['id'];
            }
            $rows[$members[$uid]['relation']][] = $row;
        }

        return $rows;
    }

    /**
     * Replace a zone's items with $rows: an item naming an id keeps that row, updated; the rows
     * no item names are deleted. Runs inside the write's transaction, so a refusal changes nothing.
     *
     * @param array<string, list<array>> $rows
     */
    public static function sync(Model $m, string $zone, array $members, array $rows): void
    {
        $held = [];
        foreach ($members as $member) {
            $held[$member['relation']] = $m->{$member['relation']}()->get()->keyBy(fn (Model $item) => (string) $item->getKey());
        }
        foreach ($rows as $relation => $items) {
            foreach ($items as $row) {
                if (isset($row['id']) && ! isset($held[$relation][(string) $row['id']])) {
                    throw new StrapiError(400, 'ApplicationError', "Some of the provided components in {$zone} are not related to the entity");
                }
            }
        }
        foreach ($members as $member) {
            $relation = $member['relation'];
            $items = $rows[$relation] ?? [];
            $kept = array_map('strval', array_column($items, 'id'));
            foreach ($held[$relation] as $id => $item) {
                if (! in_array((string) $id, $kept, true)) {
                    $item->delete();
                }
            }
            foreach ($items as $row) {
                $id = $row['id'] ?? null;
                unset($row['id']);
                $columns = array_diff_key($row, ['__links' => true, '__children' => true]);
                // An item kept by its id keeps the links and nested items it leaves out.
                $item = $id === null ? $m->{$relation}()->make($columns) : $held[$relation][(string) $id]->fill($columns);
                StrapiItems::write($item, $row);
            }
            $m->unsetRelation($relation);
        }
    }

    /**
     * A zone's items as the admin's Builder holds them: [uuid => ['type' => uid, 'data' => ...]],
     * each item's data its columns, its picked files and to-many targets by id, and the items of
     * the repeatables inside it, held the same way.
     */
    public static function builder(?Model $m, array $members): array
    {
        if ($m === null || ! $m->exists) {
            return [];
        }
        $items = [];
        foreach ($members as $uid => $member) {
            foreach ($m->{$member['relation']}()->get() as $item) {
                $data = Arr::except(self::state($item, self::node($member)), ['position']);
                $items[] = [$item->getAttribute('position'), ['type' => $uid, 'data' => $data]];
            }
        }
        usort($items, fn (array $a, array $b) => $a[0] <=> $b[0]);
        $state = [];
        foreach ($items as [, $item]) {
            $state[(string) Str::uuid()] = $item;
        }

        return $state;
    }

    /**
     * The admin Builder's state as each member relation's rows, in its order.
     *
     * @return array<string, list<array>>
     */
    public static function fromBuilder(?array $state, array $members): array
    {
        $rows = array_fill_keys(array_column($members, 'relation'), []);
        foreach (array_values($state ?? []) as $position => $item) {
            $member = $members[$item['type'] ?? ''] ?? null;
            if ($member !== null) {
                $rows[$member['relation']][] = ['position' => $position] + self::row((array) ($item['data'] ?? []), self::node($member));
            }
        }

        return $rows;
    }

    /** One item's form state: its columns, its picks by id, and its nested items by uuid. */
    private static function state(Model $item, array $node): array
    {
        $data = Arr::only($item->getAttributes(), $item->getFillable());
        foreach ($node['picks'] as $field) {
            $picked = $item->{$field['relation']}();
            // Files in the order given; targets in the order the list keeps.
            $order = $field['kind'] === 'belongsToMany' ? ($field['order'] ?? null) : 'order';
            if ($order !== null) {
                $picked->orderByPivot($order);
            }
            $data[$field['relation']] = array_map('intval', $picked->pluck($picked->getRelated()->getQualifiedKeyName())->all());
        }
        foreach ($node['children'] as $child) {
            $nested = [];
            foreach ($item->{$child['component']}()->orderBy('id')->get() as $row) {
                $nested[(string) Str::uuid()] = self::state($row, self::node($child));
            }
            $data[$child['component']] = $nested;
        }

        return $data;
    }

    /** One item's form state as the row StrapiItems writes: its columns, links and nested rows. */
    private static function row(array $data, array $node): array
    {
        $skip = array_flip([...array_column($node['picks'], 'relation'), ...array_column($node['children'], 'component')]);
        $row = array_filter(array_diff_key($data, $skip), fn ($v) => $v !== null);
        if ($node['picks'] !== []) {
            $row['__links'] = StrapiRelations::picked($node['picks'], $data);
        }
        foreach ($node['children'] as $child) {
            $row['__children'][$child['component']] = array_map(
                fn (mixed $nested): array => self::row((array) $nested, self::node($child)),
                array_values((array) ($data[$child['component']] ?? [])),
            );
        }

        return $row;
    }

    /**
     * What the admin picks for an item of a zone member or of a repeatable (an entry of a
     * member's 'children'): its files and to-many targets by id (a to-one is its key column),
     * and its repeatables.
     *
     * @return array{picks: array<string, array>, children: list<array>}
     */
    private static function node(array $entry): array
    {
        $fields = isset($entry['component']) ? $entry['fields'] : [...$entry['fields'] ?? [], ...$entry['links'] ?? []];
        $children = isset($entry['component'])
            ? array_filter($fields, fn (array $f): bool => isset($f['component']))
            : ($entry['children'] ?? []);

        return [
            'picks' => array_filter($fields, fn (array $f): bool => in_array($f['kind'] ?? null, ['mediaOne', 'mediaMany', 'belongsToMany'], true)),
            'children' => array_values($children),
        ];
    }
}
`;
