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
 * $members is a serializer's `ZONES[zone]`: uid → ['relation' => ..., 'components' => [...]].
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
                $id === null ? $m->{$relation}()->create($row) : $held[$relation][(string) $id]->fill($row)->save();
            }
            $m->unsetRelation($relation);
        }
    }

    /** A zone's items as the admin's Builder holds them: [uuid => ['type' => uid, 'data' => columns]]. */
    public static function builder(?Model $m, array $members): array
    {
        if ($m === null || ! $m->exists) {
            return [];
        }
        $items = [];
        foreach ($members as $uid => $member) {
            foreach ($m->{$member['relation']}()->get() as $item) {
                $columns = Arr::except(Arr::only($item->getAttributes(), $item->getFillable()), ['position']);
                $items[] = [$item->getAttribute('position'), ['type' => $uid, 'data' => $columns]];
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
                $rows[$member['relation']][] = ['position' => $position] + array_filter((array) ($item['data'] ?? []), fn ($v) => $v !== null);
            }
        }

        return $rows;
    }
}
`;
