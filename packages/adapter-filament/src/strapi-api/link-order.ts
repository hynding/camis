import { PHP_MARKER } from "../hooks/names";
import type { LinkOrder, WireShape } from "./wire-shape";

export const LINK_ORDER_MIGRATION_PATH =
  "database/migrations/0001_01_03_000000_add_link_order_columns.php";

/** Every order column the shapes' to-many sides read, once each, by table then column. */
export const linkOrderColumns = (shapes: Iterable<WireShape>): LinkOrder[] => {
  const seen = new Map<string, LinkOrder>();
  for (const shape of shapes) {
    for (const r of shape.relations) {
      for (const order of [r.order, r.inverseOrder]) {
        if (order !== null) seen.set(`${order.table}.${order.column}`, order);
      }
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column),
  );
};

/**
 * Strapi's link order: the place of each linked row in a to-many list, kept beside the link (on the
 * pivot, or beside the foreign key), as Strapi's `*_ord` columns are. Fractional while a connect
 * places a row between two others, renumbered from 1 after it.
 */
export const emitLinkOrderMigration = (columns: LinkOrder[]): string => {
  const byTable = new Map<string, string[]>();
  for (const { table, column } of columns)
    byTable.set(table, [...(byTable.get(table) ?? []), column]);
  const tables = (body: (columns: string[]) => string): string =>
    [...byTable.entries()]
      .map(
        ([table, cols]) => `        Schema::table('${table}', function (Blueprint $table): void {
${body(cols)}
        });`,
      )
      .join("\n");
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
${tables((cols) => cols.map((c) => `            $table->double('${c}')->nullable();`).join("\n"))}
    }

    public function down(): void
    {
${tables((cols) => `            $table->dropColumn([${cols.map((c) => `'${c}'`).join(", ")}]);`)}
    }
};
`;
};

const header = `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n`;

/**
 * Strapi's link order over Eloquent: a to-many relation's links, on its pivot or beside the target's
 * foreign key, written as strapi-php's entity manager writes its link tables. A set is kept in the
 * order given; a connect goes where its position says (the end without one), placed by Strapi's
 * relations orderer among the adjacent links only, then the list is renumbered from 1. A new link
 * takes the end of the target's own list. `link-order-vectors.json` is the check.
 */
export const emitStrapiLinkOrder = (): string =>
  header +
  String.raw`
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\Relation;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

final class StrapiLinkOrder
{
    /**
     * @param array{relation: array, set: ?list<int>, connect: list<array{id: int, position: ?array}>, disconnect: list<int>} $link
     */
    public static function write(Model $row, Relation $eloquent, array $link): void
    {
        $links = ['row' => $row, 'eloquent' => $eloquent, 'relation' => $link['relation'], 'pivot' => $eloquent instanceof BelongsToMany];
        if ($link['set'] !== null) {
            self::unlink($links, array_values(array_diff(array_keys(self::orders($links)), $link['set'])));
            foreach (array_values($link['set']) as $i => $id) {
                self::place($links, $id, $i + 1);
            }

            return;
        }
        $connectIds = array_column($link['connect'], 'id');
        $deleted = array_values(array_diff(array_intersect($link['disconnect'], array_keys(self::orders($links))), $connectIds));
        $connect = self::rehomed(self::orders($links), $link['connect'], $deleted);
        self::unlink($links, $deleted);
        if ($connect === []) {
            return;
        }
        $map = (new StrapiRelationsOrderer(self::adjacent(self::orders($links), $connect)))->connect($connect)->orderMap();
        foreach ($connect as $item) {
            self::place($links, $item['id'], $map[$item['id']] ?? null);
        }
        self::renumber($links);
    }

    /** A to-many read in link order: unordered links (an admin edit) last, then by id. */
    public static function sort(mixed $query, string $column): void
    {
        $wrapped = $query->toBase()->getGrammar()->wrap($column);
        $query->orderByRaw("CASE WHEN {$wrapped} IS NULL THEN 1 ELSE 0 END")->orderBy($column);
    }

    /** The order a row newly linked to-one takes: the end of its target's list. */
    public static function next(Model $row, string $foreignKey, string $column, mixed $target): ?float
    {
        if ($target === null) {
            return null;
        }

        return (float) ($row->newQuery()->where($foreignKey, $target)->max($column) ?? 0) + 1;
    }

    /**
     * Ids by link order: unordered links last, then by id, on every database.
     *
     * @param array<int, ?float> $orders
     * @return list<int>
     */
    public static function ordered(array $orders): array
    {
        $ids = array_keys($orders);
        usort($ids, fn (int $a, int $b) => [$orders[$a] === null, $orders[$a], $a] <=> [$orders[$b] === null, $orders[$b], $b]);

        return $ids;
    }

    /**
     * The links a connect is placed among: those it names as neighbours, and the first and last.
     *
     * @param array<int, ?float> $orders
     * @return list<array{id: int, order: ?float}>
     */
    private static function adjacent(array $orders, array $connect): array
    {
        $anchors = [];
        foreach ($connect as $item) {
            $anchor = $item['position']['after'] ?? $item['position']['before'] ?? null;
            if ($anchor !== null) {
                $anchors[] = (int) $anchor;
            }
        }
        $known = array_values(array_filter($orders, fn (?float $order) => $order !== null));
        $ends = $known === [] ? [] : [min($known), max($known)];
        $adjacent = [];
        foreach (self::ordered($orders) as $id) {
            if (in_array($id, $anchors, true) || in_array($orders[$id], $ends, true)) {
                $adjacent[] = ['id' => $id, 'order' => $orders[$id]];
            }
        }

        return $adjacent;
    }

    /**
     * A connect placed next to a link the same request disconnects goes next to that link's
     * nearest neighbour that stays, as Strapi rewrites it.
     *
     * @param array<int, ?float> $orders
     * @param list<int> $deleted
     */
    private static function rehomed(array $orders, array $connect, array $deleted): array
    {
        $anchorOf = fn (array $item): ?int => isset($item['position']['before']) ? (int) $item['position']['before'] : (isset($item['position']['after']) ? (int) $item['position']['after'] : null);
        $ordered = self::ordered($orders);
        $groups = [];
        foreach ($connect as $item) {
            $anchor = $anchorOf($item);
            if ($anchor !== null && in_array($anchor, $deleted, true) && in_array($anchor, $ordered, true)) {
                $groups[$anchor][isset($item['position']['before']) ? 'before' : 'after'][] = $item;
            }
        }
        if ($groups === []) {
            return $connect;
        }
        $connectIds = array_column($connect, 'id');
        $neighbour = function (int $id, int $step) use ($ordered, $deleted, $connectIds): ?int {
            for ($i = (int) array_search($id, $ordered, true) + $step; isset($ordered[$i]); $i += $step) {
                if (! in_array($ordered[$i], $deleted, true) && ! in_array($ordered[$i], $connectIds, true)) {
                    return $ordered[$i];
                }
            }

            return null;
        };
        $positions = [];
        foreach ($groups as $anchor => $group) {
            $previous = $neighbour($anchor, -1);
            $next = $neighbour($anchor, 1);
            foreach ([...($group['before'] ?? []), ...($group['after'] ?? [])] as $item) {
                $positions[$item['id']] = $previous !== null ? ['after' => $previous] : ($next !== null ? ['before' => $next] : ['start' => true]);
                $previous = $item['id'];
            }
        }

        return array_map(fn (array $item) => isset($positions[$item['id']]) ? ['id' => $item['id'], 'position' => $positions[$item['id']]] : $item, $connect);
    }

    // ------------------------------------------------------- one row's links of one relation

    /** @return array<int, ?float> linked id → its order */
    private static function orders(array $links): array
    {
        $orders = [];
        foreach (self::rows($links)->get([self::linked($links).' as linked', $links['relation']['order'].' as ord']) as $link) {
            $orders[(int) $link->linked] = $link->ord === null ? null : (float) $link->ord;
        }

        return $orders;
    }

    /** @param list<int> $ids */
    private static function unlink(array $links, array $ids): void
    {
        if ($ids === []) {
            return;
        }
        $relation = $links['relation'];
        if ($links['pivot']) {
            self::rows($links)->whereIn(self::linked($links), $ids)->delete();
        } else {
            $relation['model']::query()->whereKey($ids)->update([$relation['foreignKey'] => null, $relation['order'] => null]);
        }
    }

    /** Links $id at $order, or moves it there when it is linked already. */
    private static function place(array $links, int $id, int|float|null $order): void
    {
        $relation = $links['relation'];
        $linked = self::rows($links)->where(self::linked($links), $id);
        if ($linked->exists()) {
            $linked->update([$relation['order'] => $order]);
        } elseif (! $links['pivot']) {
            $relation['model']::query()->whereKey($id)->update([$relation['foreignKey'] => $links['row']->getKey(), $relation['order'] => $order]);
        } else {
            $pivot = $links['eloquent']->getTable();
            $values = [$links['eloquent']->getForeignPivotKeyName() => $links['row']->getKey(), self::linked($links) => $id, $relation['order'] => $order];
            if (($relation['inverseOrder'] ?? null) !== null) {
                $values[$relation['inverseOrder']] = (float) (DB::table($pivot)->where(self::linked($links), $id)->max($relation['inverseOrder']) ?? 0) + 1;
            }
            DB::table($pivot)->insert($values);
        }
    }

    /** Renumbers the links 1, 2, … in their order, as Strapi closes the gaps after a connect. */
    private static function renumber(array $links): void
    {
        $orders = self::orders($links);
        foreach (self::ordered($orders) as $i => $id) {
            if ($orders[$id] !== (float) ($i + 1)) {
                self::rows($links)->where(self::linked($links), $id)->update([$links['relation']['order'] => $i + 1]);
            }
        }
    }

    private static function rows(array $links): Builder
    {
        $relation = $links['relation'];

        return $links['pivot']
            ? DB::table($links['eloquent']->getTable())->where($links['eloquent']->getForeignPivotKeyName(), $links['row']->getKey())
            : $relation['model']::query()->where($relation['foreignKey'], $links['row']->getKey())->toBase();
    }

    private static function linked(array $links): string
    {
        return $links['pivot'] ? $links['eloquent']->getRelatedPivotKeyName() : $links['eloquent']->getRelated()->getKeyName();
    }
}
`;

/**
 * Strapi's relations orderer (`entity-manager/relations-orderer.ts`, as strapi-php ports it): where
 * each connected link goes among the adjacent links read from the database. A link placed next to
 * one connected in the same request is placed after it; one placed next to a link that is not
 * there is refused, as Strapi's strict mode does.
 */
export const emitStrapiRelationsOrderer = (): string =>
  header +
  String.raw`
final class StrapiRelationsOrderer
{
    /** @var list<array{id: int, order: float, init?: bool}> */
    private array $relations = [];

    private float $maxOrder = 0.0;

    /** @param list<array{id: int, order: ?float}> $adjacent */
    public function __construct(array $adjacent)
    {
        foreach ($adjacent as $link) {
            $this->relations[] = ['init' => true, 'id' => $link['id'], 'order' => $link['order'] ?? 1.0];
        }
        usort($this->relations, fn (array $a, array $b) => $a['order'] <=> $b['order']);
        foreach ($this->relations as $link) {
            $this->maxOrder = max($this->maxOrder, $link['order']);
        }
    }

    /** @param list<array{id: int, position: ?array}> $connect */
    public function connect(array $connect): self
    {
        foreach ($this->sorted($connect) as $link) {
            $this->remove($link['id']);
            $this->insert($link);
        }

        return $this;
    }

    /** @return array<int, float> each connected link's order, between its neighbours' */
    public function orderMap(): array
    {
        $chunks = [];
        foreach ($this->relations as $link) {
            $chunks[(string) $link['order']][] = $link;
        }
        uksort($chunks, fn (string $a, string $b) => (float) $a <=> (float) $b);
        $map = [];
        foreach ($chunks as $order => $links) {
            $offset = 1;
            foreach ($links as $link) {
                if (empty($link['init'])) {
                    $map[$link['id']] = (float) $order + ($offset / (count($links) + 1)) * 0.49;
                    $offset++;
                }
            }
        }

        return $map;
    }

    /**
     * The connect list with each link after the one it is placed next to, when that one is
     * connected in the same request.
     *
     * @param list<array{id: int, position: ?array}> $connect
     * @return list<array{id: int, position: ?array}>
     */
    private function sorted(array $connect): array
    {
        $known = array_flip(array_column($this->relations, 'id'));
        $byId = [];
        $needsSorting = false;
        foreach ($connect as $link) {
            $adjacent = self::adjacent($link);
            if ($adjacent === null || (! isset($known[$adjacent]) && ! isset($byId[$adjacent]))) {
                $needsSorting = true;
            }
            $byId[$link['id']] ??= $link;
        }
        if (! $needsSorting) {
            return $connect;
        }
        $sorted = [];
        $done = [];
        $visit = function (array $link, array $branch) use (&$visit, &$sorted, &$done, $byId, $known): void {
            $adjacent = self::adjacent($link);
            if ($adjacent !== null && isset($branch[$adjacent])) {
                throw StrapiError::validation('A circular reference was found in the connect array. One relation is trying to connect before/after another one that is trying to connect before/after it');
            }
            if (isset($done[$link['id']])) {
                return;
            }
            $done[$link['id']] = true;
            if ($adjacent === null || isset($known[$adjacent])) {
                $sorted[] = $link;

                return;
            }
            if (! isset($byId[$adjacent])) {
                throw StrapiError::validation(sprintf(
                    'There was a problem connecting relation with id %s at position %s. The relation with id %s needs to be connected first.',
                    $link['id'],
                    json_encode($link['position'], JSON_UNESCAPED_SLASHES),
                    $adjacent,
                ));
            }
            $visit($byId[$adjacent], $branch + [$link['id'] => true]);
            $sorted[] = $link;
        };
        foreach ($connect as $link) {
            $visit($link, []);
        }

        return $sorted;
    }

    private static function adjacent(array $link): ?int
    {
        $position = $link['position'] ?? [];
        $adjacent = $position['before'] ?? $position['after'] ?? null;

        return $adjacent === null ? null : (int) $adjacent;
    }

    private function find(int $id): int
    {
        foreach ($this->relations as $i => $link) {
            if ($link['id'] === $id) {
                return $i;
            }
        }

        return -1;
    }

    private function remove(int $id): void
    {
        $i = $this->find($id);
        if ($i >= 0) {
            array_splice($this->relations, $i, 1);
        }
    }

    private function insert(array $link): void
    {
        $position = is_array($link['position'] ?? null) ? $link['position'] : [];
        if (! empty($position['before']) || ! empty($position['after'])) {
            $before = ! empty($position['before']);
            $i = $this->find((int) ($before ? $position['before'] : $position['after']));
            if ($i < 0) {
                throw StrapiError::validation(sprintf(
                    'There was a problem connecting relation with id %s at position %s. The list of connect relations is not valid',
                    $link['id'],
                    json_encode($position, JSON_UNESCAPED_SLASHES),
                ));
            }
            $neighbour = $this->relations[$i];
            $order = empty($neighbour['init']) ? $neighbour['order'] : $neighbour['order'] + ($before ? -0.5 : 0.5);
            $at = $before ? $i : $i + 1;
        } elseif (! empty($position['start'])) {
            $first = $this->relations[0] ?? null;
            $order = $first === null ? 0.5 : (empty($first['init']) ? $first['order'] : $first['order'] - 0.5);
            $at = 0;
        } else {
            $order = $this->maxOrder + 0.5;
            $at = count($this->relations);
        }
        array_splice($this->relations, $at, 0, [['id' => $link['id'], 'order' => $order]]);
    }
}
`;
