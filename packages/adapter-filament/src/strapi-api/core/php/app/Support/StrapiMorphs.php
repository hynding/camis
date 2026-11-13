<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

/**
 * Strapi's polymorphic relations, from the side that names them: a morphToMany's links are rows of
 * its own table (the entry, the linked entry's id and uid, an order), a morphToOne's the two
 * columns of the entry's row. Each link names its entry's type by Strapi uid, which
 * StrapiMorphTypes resolves. A serializer's FIELDS entry says which: ['morph' => 'morphToMany',
 * 'table', 'ownerColumn', 'idColumn', 'typeColumn'] or ['morph' => 'morphToOne', 'idColumn',
 * 'typeColumn']. Their inverses are ordinary relations read through these links.
 */
final class StrapiMorphs
{
    // ------------------------------------------------------------------------------ writing

    /**
     * A morphToMany key of a request's data, as the links it sets, connects and disconnects, each
     * a [uid, id] pair resolved in the writer's locale. Strapi refuses a morphToOne key, a link
     * without its __type and one to a type the caller may not read, as an invalid key.
     *
     * @return array{relation: array, set: ?list<array{0: string, 1: int}>, connect: list<array{0: string, 1: int}>, disconnect: list<array{0: string, 1: int}>}
     */
    public static function instruction(string $key, array $field, mixed $value, ?Authenticatable $viewer, ?string $locale): array
    {
        $invalid = fn (): StrapiError => StrapiError::validation("Invalid key {$key}", ['key' => $key, 'path' => $key, 'source' => 'body']);
        if ($field['morph'] !== 'morphToMany' || $value === null || ! is_array($value)) {
            throw $invalid();
        }
        $link = ['relation' => $field + ['kind' => 'morphToMany'], 'set' => null, 'connect' => [], 'disconnect' => []];
        $resolve = fn (mixed $references): array => self::resolve(is_array($references) && array_is_list($references) ? $references : [$references], $viewer, $locale, $invalid);
        if (array_is_list($value)) {
            $link['set'] = $resolve($value);
        } elseif (array_key_exists('set', $value)) {
            $link['set'] = $resolve($value['set']);
        } else {
            $link['connect'] = $resolve($value['connect'] ?? []);
            $link['disconnect'] = $resolve($value['disconnect'] ?? []);
        }

        return $link;
    }

    /**
     * References to [uid, id] pairs, once each in the order given.
     *
     * @return list<array{0: string, 1: int}>
     */
    private static function resolve(array $references, ?Authenticatable $viewer, ?string $locale, \Closure $invalid): array
    {
        $byType = [];
        foreach ($references as $i => $reference) {
            $type = is_array($reference) ? ($reference['__type'] ?? null) : null;
            if (! is_string($type) || ! isset(StrapiMorphTypes::TYPES[$type])) {
                throw $invalid();
            }
            $byType[$type][$i] = $reference;
        }
        $resolved = [];
        foreach ($byType as $type => $typed) {
            $target = self::target($type);
            if (! StrapiQuery::readable($target, $viewer)) {
                throw $invalid();
            }
            $target['locale'] = $target['localized'] ? ($locale ?? StrapiLocales::default()) : null;
            foreach (array_combine(array_keys($typed), StrapiRelations::resolveEach($target, array_values($typed), $viewer)) as $i => $id) {
                $resolved[$i] = [$type, $id];
            }
        }
        ksort($resolved);
        $unique = [];
        foreach ($resolved as $pair) {
            $unique[implode('#', $pair)] = $pair;
        }

        return array_values($unique);
    }

    /** Rewrites a row's link rows as the instruction leaves them, in order. */
    public static function write(Model $row, array $link): void
    {
        $field = $link['relation'];
        $current = self::stored($row, $field);
        if ($link['set'] !== null) {
            $wanted = $link['set'];
        } else {
            $gone = array_map(fn (array $pair) => implode('#', $pair), $link['disconnect']);
            $wanted = array_values(array_filter($current, fn (array $pair) => ! in_array(implode('#', $pair), $gone, true)));
            foreach ($link['connect'] as $pair) {
                if (! in_array($pair, $wanted, true)) {
                    $wanted[] = $pair;
                }
            }
        }
        self::put($row, $field, $wanted);
    }

    /**
     * A row's links, in their order.
     *
     * @return list<array{0: string, 1: int}>
     */
    private static function stored(Model $row, array $field): array
    {
        return DB::table($field['table'])
            ->where($field['ownerColumn'], $row->getKey())
            ->orderBy('order')->orderBy('id')
            ->get([$field['typeColumn'], $field['idColumn']])
            ->map(fn (object $link) => [(string) $link->{$field['typeColumn']}, (int) $link->{$field['idColumn']}])
            ->all();
    }

    /** @param list<array{0: string, 1: int}> $pairs */
    private static function put(Model $row, array $field, array $pairs): void
    {
        DB::table($field['table'])->where($field['ownerColumn'], $row->getKey())->delete();
        DB::table($field['table'])->insert(array_map(fn (array $pair, int $i) => [
            $field['ownerColumn'] => $row->getKey(),
            $field['idColumn'] => $pair[1],
            $field['typeColumn'] => $pair[0],
            'order' => $i + 1,
        ], $pairs, array_keys($pairs)));
    }

    // ---------------------------------------------------------------------------- publishing

    /**
     * One version's polymorphic links over another's: each linked entry of a draft-and-publish
     * type as the version being written should hold it, as a relation's links are.
     */
    public static function copy(Model $from, Model $to, array $field, bool $published): void
    {
        if ($field['morph'] === 'morphToOne') {
            $type = $from->getAttribute($field['typeColumn']);
            $id = $from->getAttribute($field['idColumn']);
            $mapped = is_string($type) && $id !== null ? self::counterparts([[$type, (int) $id]], $published) : [];
            $to->setAttribute($field['typeColumn'], $mapped[0][0] ?? null);
            $to->setAttribute($field['idColumn'], $mapped[0][1] ?? null);

            return;
        }
        self::put($to, $field, self::counterparts(self::stored($from, $field), $published));
    }

    /**
     * @param list<array{0: string, 1: int}> $pairs
     * @return list<array{0: string, 1: int}>
     */
    private static function counterparts(array $pairs, bool $published): array
    {
        $mapped = [];
        foreach ($pairs as $i => [$type, $id]) {
            if (! isset(StrapiMorphTypes::TYPES[$type])) {
                continue;
            }
            $version = StrapiDocuments::counterparts(self::target($type), [$id], $published)[0] ?? null;
            if ($version !== null) {
                $mapped[$i] = [$type, $version];
            }
        }

        return array_values($mapped);
    }

    // ------------------------------------------------------------------------------ reading

    /**
     * What populate reads for a polymorphic key, in StrapiPopulate's shape: each row's linked
     * entries (or their number), each rendered once with its __type. An entry of a type the caller
     * may not read is left out, as Strapi's populate leaves it; one of a draft-and-publish type is
     * shown in the status asked for.
     *
     * @return array{count: bool, links: array<int|string, list<string>|int>, wires: array<string, array>}
     */
    public static function load(Collection $rows, array $field, array $sub, ?Authenticatable $viewer, bool $published): array
    {
        $byRow = [];
        foreach ($rows as $row) {
            $byRow[$row->getKey()] = $field['morph'] === 'morphToOne'
                ? array_values(array_filter([[$row->getAttribute($field['typeColumn']), $row->getAttribute($field['idColumn'])]], fn (array $pair) => is_string($pair[0]) && $pair[1] !== null))
                : [];
        }
        if ($field['morph'] === 'morphToMany' && $byRow !== []) {
            $links = DB::table($field['table'])
                ->whereIn($field['ownerColumn'], array_keys($byRow))
                ->orderBy('order')->orderBy('id')
                ->get([$field['ownerColumn'], $field['typeColumn'], $field['idColumn']]);
            foreach ($links as $link) {
                $byRow[$link->{$field['ownerColumn']}][] = [(string) $link->{$field['typeColumn']}, (int) $link->{$field['idColumn']}];
            }
        }

        [$keys, $wires] = self::entries(array_merge([], ...array_values($byRow)), $viewer, $published);
        $count = in_array($sub['count'] ?? null, [true, 'true', '1', 1], true);
        $links = [];
        foreach ($byRow as $row => $pairs) {
            $linked = [];
            foreach ($pairs as [$type, $id]) {
                $key = $keys[$type][(int) $id] ?? null;
                if ($key !== null) {
                    $linked[] = $key;
                }
            }
            $links[$row] = $count ? count($linked) : $linked;
        }

        return ['count' => $count, 'links' => $links, 'wires' => $count ? [] : $wires];
    }

    /**
     * Each linked entry the caller may see, rendered once as Strapi renders a populated one: its
     * own fields and its __type.
     *
     * @param list<array{0: string, 1: int|string}> $pairs
     * @return array{0: array<string, array<int, string>>, 1: array<string, array>} uid → linked id → the entry's key, and each key's wire
     */
    private static function entries(array $pairs, ?Authenticatable $viewer, bool $published): array
    {
        $byType = [];
        foreach ($pairs as [$type, $id]) {
            $byType[$type][(int) $id] = (int) $id;
        }
        $keys = [];
        $wires = [];
        foreach ($byType as $type => $ids) {
            if (! isset(StrapiMorphTypes::TYPES[$type])) {
                continue;
            }
            $target = self::target($type);
            if (! StrapiQuery::readable($target, $viewer)) {
                continue;
            }
            // A link holds the version it was written with; a reader asks for one status.
            $shown = $target['draftPublish'] ? self::versions($target, array_values($ids), $published) : $ids;
            $query = $target['model']::query()->whereKey(array_values(array_unique($shown)));
            StrapiQuery::scope($query, $viewer);
            $rows = $query->get()->filter(fn (Model $row) => StrapiQuery::visible($row, $viewer))->values();
            $rendered = [];
            foreach (StrapiPopulate::many($rows, [], $target['serializer'], $viewer) as $i => $wire) {
                $key = "{$type}#{$rows[$i]->getKey()}";
                $rendered[(int) $rows[$i]->getKey()] = $key;
                $wires[$key] = $wire + ['__type' => $type];
            }
            foreach ($shown as $linked => $version) {
                if (isset($rendered[$version])) {
                    $keys[$type][$linked] = $rendered[$version];
                }
            }
        }

        return [$keys, $wires];
    }

    /**
     * Each linked id → the id of its document's version of the status asked for.
     *
     * @param list<int> $ids
     * @return array<int, int>
     */
    private static function versions(array $target, array $ids, bool $published): array
    {
        $versions = [];
        foreach ($ids as $id) {
            $version = StrapiDocuments::counterparts($target, [$id], $published)[0] ?? null;
            if ($version !== null) {
                $versions[$id] = $version;
            }
        }

        return $versions;
    }

    /** A linked type as a relation's target, which the relation helpers take. */
    private static function target(string $type): array
    {
        [$model, $serializer] = StrapiMorphTypes::TYPES[$type];

        return [
            'model' => $model,
            'serializer' => $serializer,
            'uid' => $type,
            'draftPublish' => $serializer::DRAFT_PUBLISH,
            'localized' => $serializer::LOCALIZED,
        ];
    }
}
