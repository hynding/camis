import { PHP_MARKER } from "../../hooks/names";

/**
 * `App\Support\StrapiComponents` — the reader/writer for Strapi's component storage.
 *
 * Split out of `runtime.ts` purely for file size: it is one class, and it is the only one of the
 * five runtime files with real algorithmic weight.
 */
export const emitStrapiComponents = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Query\\Builder;
use Illuminate\\Support\\Collection;
use Illuminate\\Support\\Facades\\DB;
use stdClass;

/**
 * Reads and writes Strapi's component storage for a model, driven by that model's COMPONENT_MAP.
 *
 * Strapi keeps a component's values in the component's own table (\`components_finance_money\`) and
 * records ownership in a link table on the owner (\`transactions_cmps\`), one row per component
 * instance: \`entity_id\` (the owner row), \`cmp_id\` (the component row), \`component_type\`
 * (\`finance.money\`), \`field\` (the owner's attribute name) and \`order\` (NULL for a single
 * component, 1..n within a repeatable one). A component nested inside a component repeats the
 * pattern one level down, with the parent *component row's* id as \`entity_id\`.
 *
 * The rest of the generated app speaks the flat Filament shape instead: a single component's
 * scalars are attributes on the owner (\`amount_minor\`, \`facts_serving_size_amount\`) and a
 * repeatable one is a child relation (\`factsAdditional\`). This class is the whole translation, so
 * the serializers and controllers keep reading and writing the shape they already know.
 *
 * Map entries carry: field, wireKey, flatPrefix, relationName (repeatable only), repeatable,
 * table, type, cmpsTable, scalars [column, flatAttribute, type] and nested (the same shape again).
 */
final class StrapiComponents
{
    /**
     * Loads every mapped component for a whole result set in a bounded number of queries: one on
     * the link table per nesting level plus one per component table, however many owners were
     * passed in. Every mapped attribute is written even when no component row exists, so a
     * serializer never has to tell "absent" from "not loaded".
     */
    public static function load(Collection $rows, array $map): void
    {
        $entities = [];

        foreach ($rows as $row) {
            if (! $row instanceof Model) {
                continue;
            }

            // Marked loaded before the first lookup so the lazy accessors in
            // StrapiComponentAttributes cannot re-enter this loader while it runs.
            $row->strapiComponents = [];
            $row->strapiComponentsLoaded = true;
            self::blank($row, $map);
            $entities[$row->getKey()] = $row;
        }

        $first = $rows->first();

        if ($entities === [] || ! $first instanceof Model) {
            return;
        }

        self::loadLevel($first->getConnectionName(), $entities, $map);
    }

    public static function loadOne(Model $m, array $map): void
    {
        self::load(new Collection([$m]), $map);
    }

    /**
     * Replaces the components a Phase 16 wire array mentions. A component the payload does not
     * mention is left untouched (partial update); a single component whose scalars are all null
     * and which carries no nested data is removed rather than re-inserted.
     *
     * Several statements, no transaction of its own: the caller already wraps the row write and
     * this call in a single database transaction, and opening one here would only add a savepoint.
     */
    public static function apply(Model $m, array $map, array $wire): void
    {
        $columns = is_array($wire['columns'] ?? null) ? $wire['columns'] : [];
        $children = is_array($wire['children'] ?? null) ? $wire['children'] : [];
        $connection = $m->getConnectionName();

        foreach ($map as $c) {
            if (! self::mentioned($c, $columns, $children)) {
                continue;
            }

            self::write($connection, $m->getKey(), $c, $columns, $children);
        }

        self::forget($m, $map);
    }

    /**
     * The wire columns that are really the owner's own: every flattened component attribute
     * removed, so the result is safe to hand to Model::fill().
     */
    public static function columnsOf(array $wire, array $map): array
    {
        $columns = is_array($wire['columns'] ?? null) ? $wire['columns'] : [];

        return array_diff_key($columns, array_flip(self::flatAttributes($map)));
    }

    /** Removes every component this row owns. Called when the row itself is deleted. */
    public static function deleteAll(Model $m, array $map): void
    {
        foreach ($map as $c) {
            self::clear($m->getConnectionName(), $m->getKey(), $c);
        }
    }

    /**
     * @param array<int|string, object> $entities link-owner row id => the object that receives the
     *                                            flattened values found beneath it
     */
    private static function loadLevel(?string $connection, array $entities, array $map): void
    {
        if ($entities === [] || $map === []) {
            return;
        }

        $fields = [];

        foreach ($map as $c) {
            $fields[] = $c['field'];
        }

        // Every component at one level hangs off the same owner table, so a single query covers
        // all of them; ordering by \`order\` is what puts a repeatable's rows in Strapi's order.
        $links = self::table($connection, $map[0]['cmpsTable'])
            ->whereIn('entity_id', array_keys($entities))
            ->whereIn('field', $fields)
            ->orderBy('order')
            ->orderBy('id')
            ->get();

        foreach ($map as $c) {
            self::loadComponent($connection, $entities, $c, $links);
        }
    }

    private static function loadComponent(
        ?string $connection,
        array $entities,
        array $c,
        Collection $links
    ): void {
        $grouped = [];
        $ids = [];

        foreach ($links as $link) {
            if ($link->field !== $c['field'] || ! array_key_exists($link->entity_id, $entities)) {
                continue;
            }

            $grouped[$link->entity_id][] = (int) $link->cmp_id;
            $ids[] = (int) $link->cmp_id;
        }

        if ($ids === []) {
            return;
        }

        $rows = self::table($connection, $c['table'])->whereIn('id', $ids)->get()->keyBy('id');
        $nested = [];

        foreach ($grouped as $entityId => $cmpIds) {
            $target = $entities[$entityId];

            if ($c['repeatable']) {
                $children = [];

                foreach ($cmpIds as $cmpId) {
                    $row = $rows->get($cmpId);

                    if ($row === null) {
                        continue;
                    }

                    $child = self::childRow($c, $row);
                    $children[] = $child;
                    $nested[$cmpId] = $child;
                }

                if ($target instanceof Model) {
                    $target->setRelation($c['relationName'], new Collection($children));
                }

                continue;
            }

            $row = $rows->get($cmpIds[0]);

            if ($row === null) {
                continue;
            }

            foreach ($c['scalars'] as $s) {
                self::put($target, $s['flatAttribute'], $row->{$s['column']} ?? null);
            }

            // A single component is flattened onto the object that owns it, so anything nested
            // under it keeps writing to that same object — only the link owner moves down.
            $nested[$cmpIds[0]] = $target;
        }

        self::loadLevel($connection, $nested, $c['nested']);
    }

    /**
     * A repeatable component's rows reach the serializer as plain objects carrying the child
     * column names it reads (\`$c->slug\`), so nothing downstream needs to know they came from a
     * component table rather than from a child table.
     */
    private static function childRow(array $c, object $row): stdClass
    {
        $child = new stdClass();
        $child->id = $row->id;

        foreach ($c['scalars'] as $s) {
            $child->{$s['flatAttribute']} = $row->{$s['column']} ?? null;
        }

        self::blank($child, $c['nested']);

        return $child;
    }

    /**
     * Writes a map's "nothing here" values onto one target — null per flattened attribute, an
     * empty Collection per repeatable relation — so a row without components serializes to the
     * same keys as one with them.
     */
    private static function blank(object $target, array $map): void
    {
        foreach ($map as $c) {
            if ($c['repeatable']) {
                // Repeatables are always exposed on the model, even when nested inside a single
                // component; a plain child row cannot hold an Eloquent relation.
                if ($target instanceof Model) {
                    $target->setRelation($c['relationName'], new Collection());
                }

                continue;
            }

            foreach ($c['scalars'] as $s) {
                self::put($target, $s['flatAttribute'], null);
            }

            self::blank($target, $c['nested']);
        }
    }

    /** Flattened values live in $strapiComponents on a model, and as plain properties on a row. */
    private static function put(object $target, string $attribute, mixed $value): void
    {
        if ($target instanceof Model) {
            $target->strapiComponents[$attribute] = $value;

            return;
        }

        $target->{$attribute} = $value;
    }

    /** True when the payload carries data for this component, or for anything nested under it. */
    private static function mentioned(array $c, array $columns, array $children): bool
    {
        if ($c['repeatable']) {
            return array_key_exists($c['relationName'], $children);
        }

        foreach ($c['scalars'] as $s) {
            if (array_key_exists($s['flatAttribute'], $columns)) {
                return true;
            }
        }

        // A payload that only mentions something nested (\`facts.additional\` alone) still has to
        // rewrite the component that owns it, or the nested rows would have nothing to hang off.
        foreach ($c['nested'] as $child) {
            if (self::mentioned($child, $columns, $children)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Replaces one component under $entityId. Strapi has no update-in-place for components: the
     * whole subtree is deleted and rewritten from the payload, which is why only a component the
     * payload actually mentions ever reaches this method.
     */
    private static function write(
        ?string $connection,
        int|string $entityId,
        array $c,
        array $columns,
        array $children
    ): void {
        self::clear($connection, $entityId, $c);

        if ($c['repeatable']) {
            $rows = $children[$c['relationName']] ?? null;
            $rows = is_array($rows) ? $rows : [];
            $order = 1;

            foreach ($rows as $row) {
                $id = self::insert($connection, $c, (array) $row, []);
                self::link($connection, $c, $entityId, $id, $order);
                $order++;
            }

            return;
        }

        // An all-null payload is how the wire says "no component here" — the serializer collapses
        // an all-null component to an omitted key — so leave the owner without one.
        if (self::isBlank($c, $columns, $children)) {
            return;
        }

        self::link($connection, $c, $entityId, self::insert($connection, $c, $columns, $children), null);
    }

    /** Inserts a component row and everything nested under it; returns the new row's id. */
    private static function insert(?string $connection, array $c, array $columns, array $children): int
    {
        $values = [];

        foreach ($c['scalars'] as $s) {
            $values[$s['column']] = $columns[$s['flatAttribute']] ?? null;
        }

        $id = (int) self::table($connection, $c['table'])->insertGetId($values);

        foreach ($c['nested'] as $child) {
            self::write($connection, $id, $child, $columns, $children);
        }

        return $id;
    }

    private static function link(
        ?string $connection,
        array $c,
        int|string $entityId,
        int $id,
        ?int $order
    ): void {
        self::table($connection, $c['cmpsTable'])->insert([
            'entity_id' => $entityId,
            'cmp_id' => $id,
            'component_type' => $c['type'],
            'field' => $c['field'],
            'order' => $order,
        ]);
    }

    /** Deletes the component rows currently linked at ($entityId, field), and their link rows. */
    private static function clear(?string $connection, int|string $entityId, array $c): void
    {
        $links = self::table($connection, $c['cmpsTable'])
            ->where('entity_id', $entityId)
            ->where('field', $c['field'])
            ->get();

        foreach ($links as $link) {
            // Depth first: a component's own components must go before the row they hang off, or
            // their link rows would outlive their owner.
            foreach ($c['nested'] as $child) {
                self::clear($connection, (int) $link->cmp_id, $child);
            }

            self::table($connection, $c['table'])->where('id', (int) $link->cmp_id)->delete();
        }

        self::table($connection, $c['cmpsTable'])
            ->where('entity_id', $entityId)
            ->where('field', $c['field'])
            ->delete();
    }

    /** True when the payload holds no value at all for this component or anything under it. */
    private static function isBlank(array $c, array $columns, array $children): bool
    {
        foreach ($c['scalars'] as $s) {
            if (($columns[$s['flatAttribute']] ?? null) !== null) {
                return false;
            }
        }

        foreach ($c['nested'] as $child) {
            if ($child['repeatable']) {
                if (($children[$child['relationName']] ?? []) !== []) {
                    return false;
                }

                continue;
            }

            if (! self::isBlank($child, $columns, $children)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Every flattened attribute the mapped components contribute to the owner's column bag.
     *
     * Repeatables are skipped whole: their scalars are bare names (\`amount\`, \`unit\`) that travel
     * in $wire['children'], and stripping those from the columns could remove a real owner column
     * that happens to share a name.
     *
     * @return list<string>
     */
    private static function flatAttributes(array $map): array
    {
        $names = [];

        foreach ($map as $c) {
            if ($c['repeatable']) {
                continue;
            }

            foreach ($c['scalars'] as $s) {
                $names[] = $s['flatAttribute'];
            }

            $names = array_merge($names, self::flatAttributes($c['nested']));
        }

        return $names;
    }

    /** Drops the cached values so the next read reflects what apply() just wrote. */
    private static function forget(Model $m, array $map): void
    {
        if (! property_exists($m, 'strapiComponents')) {
            return;
        }

        $m->strapiComponents = [];
        $m->strapiComponentsLoaded = false;
        self::forgetRelations($m, $map);
    }

    private static function forgetRelations(Model $m, array $map): void
    {
        foreach ($map as $c) {
            if ($c['repeatable']) {
                $m->unsetRelation($c['relationName']);

                continue;
            }

            self::forgetRelations($m, $c['nested']);
        }
    }

    /** Raw builder on the owner's own connection, so a model on a second connection still works. */
    private static function table(?string $connection, string $table): Builder
    {
        return DB::connection($connection)->table($table);
    }
}
`;
