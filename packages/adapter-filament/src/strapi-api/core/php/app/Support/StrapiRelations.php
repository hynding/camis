<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\Eloquent\Model;

final class StrapiRelations
{
    /**
     * The relation keys of a request's data, resolved to target ids.
     *
     * @return array<string, array{relation: array, set: ?list<int>, connect: list<array{id: int, position: ?array}>, disconnect: list<int>}>
     */
    public static function read(array $data, array $fields, ?Authenticatable $viewer, ?string $locale = null): array
    {
        $links = [];
        foreach ($fields as $key => $relation) {
            if (! isset($relation['relation']) || $relation['kind'] === 'localizations') {
                continue;
            }
            $sent = self::sent($data, (string) $key);
            if ($sent === null) {
                continue;
            }
            if (! StrapiQuery::readable($relation, $viewer)) {
                throw StrapiError::validation("Invalid key {$key}", ['key' => $key, 'path' => $key, 'source' => 'body']);
            }
            // A target that keeps locales is linked in the writer's locale, else in its default one.
            $relation['locale'] = $relation['localized'] ? ($locale ?? StrapiLocales::default()) : null;
            $links[$key] = self::instruction($relation, $sent[0], $viewer);
            // A component sent without its id is a new one, as Strapi replaces it: its links
            // start from none, so a connect or disconnect applies to nothing it held before.
            if ($sent[1] ?? false) {
                $links[$key]['fresh'] = true;
            }
        }

        return $links;
    }

    /**
     * What a write sends for a key, as [value, fresh], or null when it leaves the key alone. An
     * embedded component's file or relation (a dotted key) is sent with its component, which a
     * write replaces whole, as Strapi replaces a component sent without its id (fresh: its links
     * start from none); one sent with its id keeps what it leaves out.
     */
    private static function sent(array $data, string $key): ?array
    {
        if (array_key_exists($key, $data)) {
            return [$data[$key], false];
        }
        $path = explode('.', $key);
        if (count($path) === 1 || ! array_key_exists($path[0], $data)) {
            return null;
        }
        $value = $data;
        $fresh = false;
        foreach ($path as $i => $segment) {
            if (! is_array($value) || ! array_key_exists($segment, $value)) {
                return is_array($value) && $i > 0 && array_key_exists('id', $value) ? null : [null, true];
            }
            if ($i > 0 && is_array($value) && ! array_key_exists('id', $value)) {
                $fresh = true;
            }
            $value = $value[$segment];
        }

        return [$value, $fresh];
    }

    /**
     * Each repeatable component item's links (its files and relations, as sent) as the links its
     * row makes once saved, and the same for the items nested in it; a missing target fails the
     * whole request, as one an entry links itself does. $fields is the map holding the
     * repeatables (a serializer's FIELDS, or an item's own).
     */
    public static function items(array $children, array $fields, ?Authenticatable $viewer, ?string $locale = null): array
    {
        foreach ($fields as $field) {
            $relation = $field['component'] ?? null;
            if ($relation === null || ! isset($children[$relation])) {
                continue;
            }
            $links = array_filter($field['fields'], fn (array $f): bool => isset($f['relation']));
            foreach ($children[$relation] as $i => $row) {
                if ($links !== []) {
                    $children[$relation][$i]['__links'] = self::read($row['__links'] ?? [], $links, $viewer, $locale);
                }
                if (isset($row['__children'])) {
                    $children[$relation][$i]['__children'] = self::items($row['__children'], $field['fields'], $viewer, $locale);
                }
            }
        }

        return $children;
    }

    /**
     * Each dynamic zone item's links (its files and relations) as the links its row makes once
     * written, and its nested items', as an item of a repeatable component's are. $zones is a
     * serializer's ZONES.
     */
    public static function zones(array $children, array $zones, ?Authenticatable $viewer, ?string $locale = null): array
    {
        foreach ($zones as $zone => $members) {
            foreach ($members as $member) {
                $relation = $member['relation'];
                $links = [...$member['fields'] ?? [], ...$member['links'] ?? []];
                foreach ($children[$zone][$relation] ?? [] as $i => $row) {
                    if ($links !== []) {
                        $children[$zone][$relation][$i]['__links'] = self::read($row['__links'] ?? [], $links, $viewer, $locale);
                    }
                    if (isset($row['__children'])) {
                        $children[$zone][$relation][$i]['__children'] = self::items($row['__children'], $member['children'] ?? [], $viewer, $locale);
                    }
                }
            }
        }

        return $children;
    }

    /**
     * Links that make a row's file fields hold exactly the given files: the admin's pickers.
     *
     * @param array<string, mixed> $ids each media field's relation method → its picked file ids
     */
    public static function picked(array $fields, array $ids): array
    {
        $links = [];
        foreach ($fields as $key => $field) {
            if (array_key_exists($field['relation'], $ids)) {
                $links[$key] = ['relation' => $field, 'set' => array_values(array_map('intval', array_filter((array) $ids[$field['relation']]))), 'connect' => [], 'disconnect' => []];
            }
        }

        return $links;
    }

    /**
     * To-one foreign keys on the row itself: set before it is saved, so a required one holds. A
     * row linked to a new target takes the end of the target's list, when the target lists it.
     */
    public static function associate(Model $row, array $links): void
    {
        foreach ($links as $link) {
            if ($link['relation']['kind'] !== 'belongsTo') {
                continue;
            }
            $column = $link['relation']['foreignKey'];
            $target = self::single(($link['fresh'] ?? false) ? null : $row->getAttribute($column), $link);
            $order = $link['relation']['inverseOrder'] ?? null;
            if ($order !== null && ($target === null || (string) $target !== (string) $row->getAttribute($column))) {
                $row->setAttribute($order, StrapiLinkOrder::next($row, $column, $order, $target));
            }
            $row->setAttribute($column, $target);
        }
    }

    /** Pivot rows and the other side's foreign keys: written once the row has its id. */
    public static function link(Model $row, array $links): void
    {
        foreach ($links as $link) {
            $relation = $link['relation'];
            if ($relation['kind'] === 'belongsTo') {
                continue;
            }
            $eloquent = $row->{$relation['relation']}();
            // Published versions keep the links they were published with until the next publish.
            if ($relation['draftPublish']) {
                $eloquent->whereNull($eloquent->getRelated()->qualifyColumn('published_at'));
            }
            $media = in_array($relation['kind'], ['mediaOne', 'mediaMany'], true);
            if ($media) {
                $eloquent->orderByPivot('order');
            }
            if (($link['fresh'] ?? false) && $link['set'] === null) {
                $link['set'] = self::many([], $link);
            }
            if (($relation['order'] ?? null) !== null) {
                StrapiLinkOrder::write($row, $eloquent, $link);

                continue;
            }
            $current = array_map('intval', $eloquent->pluck($eloquent->getRelated()->getQualifiedKeyName())->all());
            $wanted = in_array($relation['kind'], ['hasOne', 'mediaOne'], true)
                ? array_values(array_filter([self::single($current[0] ?? null, $link)]))
                : self::many($current, $link);
            if ($media) {
                $eloquent->sync(self::ordered($wanted));
            } elseif ($relation['kind'] === 'belongsToMany') {
                $eloquent->sync($wanted);
            } else {
                self::moveForeignKeys($row, $relation, $current, $wanted);
            }
        }
    }

    /**
     * A media field's files with their positions, which its link rows keep.
     *
     * @param list<int> $ids
     * @return array<int, array{order: int}>
     */
    public static function ordered(array $ids): array
    {
        $ordered = [];
        foreach (array_values($ids) as $i => $id) {
            $ordered[$id] = ['order' => $i + 1];
        }

        return $ordered;
    }

    /**
     * @param list<int> $current
     * @param list<int> $wanted
     */
    private static function moveForeignKeys(Model $row, array $relation, array $current, array $wanted): void
    {
        $target = $relation['model']::query();
        $fk = $relation['foreignKey'];
        $released = array_values(array_diff($current, $wanted));
        if ($released !== []) {
            (clone $target)->whereKey($released)->update([$fk => null]);
        }
        $claimed = array_values(array_diff($wanted, $current));
        if ($claimed !== []) {
            (clone $target)->whereKey($claimed)->update([$fk => $row->getKey()]);
        }
    }

    private static function single(mixed $current, array $link): mixed
    {
        if ($link['set'] !== null) {
            return $link['set'] === [] ? null : end($link['set']);
        }
        if ($link['connect'] !== []) {
            return end($link['connect'])['id'];
        }

        return in_array((int) $current, $link['disconnect'], true) ? null : $current;
    }

    /**
     * @param list<int> $current
     * @return list<int>
     */
    private static function many(array $current, array $link): array
    {
        if ($link['set'] !== null) {
            return $link['set'];
        }
        $ids = array_values(array_diff($current, $link['disconnect']));
        foreach (array_column($link['connect'], 'id') as $id) {
            if (! in_array($id, $ids, true)) {
                $ids[] = $id;
            }
        }

        return $ids;
    }

    // ----------------------------------------------------------------------------- reading

    /** @return array{relation: array, set: ?list<int>, connect: list<array{id: int, position: ?array}>, disconnect: list<int>} */
    private static function instruction(array $relation, mixed $value, ?Authenticatable $viewer): array
    {
        $link = ['relation' => $relation, 'set' => null, 'connect' => [], 'disconnect' => []];
        if ($value === null) {
            $link['set'] = [];
        } elseif (! is_array($value) || array_is_list($value)) {
            $link['set'] = self::resolve($relation, is_array($value) ? $value : [$value], $viewer);
        } elseif (array_key_exists('documentId', $value) || array_key_exists('id', $value)) {
            $link['set'] = self::resolve($relation, [$value], $viewer);
        } elseif (array_key_exists('set', $value)) {
            $link['set'] = self::resolve($relation, self::references($value['set']), $viewer);
        } else {
            $link['connect'] = self::connects($relation, self::references($value['connect'] ?? []), $viewer);
            $link['disconnect'] = self::resolve($relation, self::references($value['disconnect'] ?? []), $viewer);
        }

        return $link;
    }

    /**
     * Connect references with their positions, the neighbours a position names resolved as the
     * references are. A position named by documentId carries the locale it was looked up in, as
     * Strapi's does (its errors show it).
     *
     * @return list<array{id: int, position: ?array}>
     */
    private static function connects(array $relation, array $references, ?Authenticatable $viewer): array
    {
        $positions = [];
        $neighbours = [];
        foreach ($references as $i => $reference) {
            $position = is_array($reference) && is_array($reference['position'] ?? null) ? $reference['position'] : null;
            foreach (['before', 'after'] as $side) {
                if (! empty($position[$side])) {
                    $neighbours[] = $position[$side];
                }
            }
            $positions[$i] = $position;
        }
        $ids = self::resolveEach($relation, $references, $viewer);
        $neighbourIds = array_combine(array_map('strval', $neighbours), self::resolveEach($relation, $neighbours, $viewer)) ?: [];
        $connect = [];
        foreach ($references as $i => $reference) {
            if (isset($connect[$ids[$i]])) {
                continue;
            }
            $position = $positions[$i];
            if ($position !== null) {
                foreach (['before', 'after'] as $side) {
                    if (! empty($position[$side])) {
                        $position[$side] = $neighbourIds[(string) $position[$side]];
                    }
                }
                if (is_array($reference) && isset($reference['documentId']) && empty($position['locale'])) {
                    $position['locale'] = $relation['locale'] ?? (class_exists(StrapiLocales::class) ? StrapiLocales::default() : 'en');
                }
            }
            $connect[$ids[$i]] = ['id' => $ids[$i], 'position' => $position];
        }

        return array_values($connect);
    }

    private static function references(mixed $value): array
    {
        return is_array($value) && array_is_list($value) ? $value : [$value];
    }

    /**
     * documentIds and numeric ids to the target's ids, one for each reference in the order given,
     * counting only rows the caller can see.
     *
     * @return list<int>
     */
    private static function resolveEach(array $relation, array $references, ?Authenticatable $viewer): array
    {
        $documentIds = [];
        $ids = [];
        foreach ($references as $reference) {
            $reference = is_array($reference) ? ($reference['documentId'] ?? $reference['id'] ?? null) : $reference;
            if (is_string($reference) && ! ctype_digit($reference)) {
                $documentIds[] = $reference;
            } elseif (is_int($reference) || (is_string($reference) && ctype_digit($reference))) {
                $ids[] = (int) $reference;
            } else {
                throw StrapiError::validation('Invalid relation reference');
            }
        }
        $byDocumentId = self::visibleRows($relation, 'document_id', $documentIds, $viewer);
        foreach ($documentIds as $documentId) {
            if (! array_key_exists($documentId, $byDocumentId)) {
                throw StrapiError::validation("Document with id \"{$documentId}\", locale \"{$relation['locale']}\" not found");
            }
        }
        $byId = self::visibleRows($relation, 'id', $ids, $viewer);
        $missing = count(array_diff(array_unique($ids), array_keys($byId)));
        if ($missing > 0) {
            $message = "{$missing} relation(s) of type {$relation['uid']} associated with this entity do not exist";
            throw StrapiError::validation($message, ['errors' => [['path' => [], 'message' => $message, 'name' => 'ValidationError']]]);
        }

        if ($relation['draftPublish']) {
            $byId = self::drafts($relation, $byId);
        }

        $resolved = [];
        foreach ($references as $reference) {
            $reference = is_array($reference) ? ($reference['documentId'] ?? $reference['id']) : $reference;
            $resolved[] = is_string($reference) && ! ctype_digit($reference) ? $byDocumentId[$reference] : $byId[(int) $reference];
        }

        return $resolved;
    }

    /** @return list<int> */
    private static function resolve(array $relation, array $references, ?Authenticatable $viewer): array
    {
        return array_values(array_unique(self::resolveEach($relation, $references, $viewer)));
    }

    /** @return array<int|string, int> column value → id */
    private static function visibleRows(array $relation, string $column, array $values, ?Authenticatable $viewer): array
    {
        if ($values === []) {
            return [];
        }
        $query = $relation['model']::query()->whereIn($column, array_values(array_unique($values)));
        if ($relation['draftPublish'] && $column === 'document_id') {
            $query->whereNull('published_at');
        }
        if ($relation['locale'] !== null && $column === 'document_id') {
            $query->where('locale', $relation['locale']);
        }
        StrapiQuery::scope($query, $viewer);
        $rows = [];
        foreach ($query->get() as $row) {
            if (StrapiQuery::visible($row, $viewer)) {
                $rows[$row->getAttribute($column)] = (int) $row->getKey();
            }
        }

        return $rows;
    }

    /**
     * @param array<int, int> $byId
     * @return array<int, int> each id → its document's draft id, in the same locale
     */
    private static function drafts(array $relation, array $byId): array
    {
        if ($byId === []) {
            return [];
        }
        $columns = $relation['localized'] ? ['document_id', 'locale'] : ['document_id'];
        $linked = $relation['model']::query()->whereKey(array_keys($byId))->get(['id', ...$columns])->keyBy('id');
        $drafts = $relation['model']::query()
            ->whereIn('document_id', $linked->pluck('document_id')->unique()->values()->all())
            ->whereNull('published_at')
            ->get(['id', ...$columns])
            ->keyBy(fn (Model $row) => StrapiDocuments::versionKey($row, $columns));
        $mapped = [];
        foreach (array_keys($byId) as $id) {
            $mapped[$id] = (int) $drafts[StrapiDocuments::versionKey($linked[$id], $columns)]->getKey();
        }

        return $mapped;
    }
}
