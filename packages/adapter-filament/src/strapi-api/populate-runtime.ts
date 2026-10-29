import { PHP_MARKER } from "../hooks/names";

const header = `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n`;

/**
 * Strapi 5's `populate` over Eloquent: components and relations stay off the wire unless the
 * request names them (`populate=*`, `populate=a,b`, `populate[0]=a.b`, `populate[a][fields]`,
 * `[filters]`, `[sort]`, `[populate]`, `[count]`), as strapi-php's `convert-query-params` and
 * populate validation do. Each relation is eager-loaded once per level for the whole page, so a
 * list costs one query per populated relation rather than one per row — what keeps it cheap on
 * shared hosting. The canonical check is `populate-vectors.json`, recorded from strapi-php.
 *
 * Draft and publish: every level shows the version the request's status names. Links between two
 * versioned types, and from a versioned type to a plain one, are held per version, so they load
 * as they are. A link a plain type holds to a versioned one points at the target's draft and is
 * shown as its published version; a link a plain type holds to a versioned one's draft is reached
 * from the published version through that draft (`draft-publish-vectors.json`). The request's
 * publicationFilter narrows every draft-and-publish level, as Strapi's does
 * (`publication-filter-vectors.json`).
 *
 * Locales: a link from a type that keeps locales holds its target in its own locale, and one from
 * a type that does not holds the target's default locale, so both load as they are.
 * `localizations` is the row's document in its other locales (`i18n-vectors.json`).
 */
export const emitStrapiPopulate = (): string =>
  header +
  String.raw`
use Closure;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\Relation;

/** $serializer is a generated serializer class: toWire(), FIELDS, COMPONENTS and ZONES. */
final class StrapiPopulate
{
    private const PARAMS = ['fields', 'filters', 'sort', 'populate', 'count', 'on'];

    public static function one(Model $row, array $params, string $serializer, ?Authenticatable $viewer): array
    {
        return self::many(new Collection([$row]), $params, $serializer, $viewer)[0];
    }

    /** @return list<array> */
    public static function many(Collection $rows, array $params, string $serializer, ?Authenticatable $viewer): array
    {
        $tree = self::tree($params['populate'] ?? null, $serializer, $viewer, null);

        return self::rendered($rows, $params, $tree, $serializer, $viewer, ! StrapiDocuments::draftOnly($params), StrapiDocuments::publicationFilter($params));
    }

    /** @return list<array> */
    private static function rendered(Collection $rows, array $params, array $tree, string $serializer, ?Authenticatable $viewer, bool $published, ?string $cohort): array
    {
        $loaded = [];
        foreach ($tree as $key => $sub) {
            $relation = $serializer::FIELDS[$key] ?? [];
            if (isset($relation['relation'])) {
                $loaded[$key] = self::load($rows, $serializer, $relation, $sub, $viewer, $key, $published, $cohort);
            }
        }

        return $rows->map(fn (Model $row) => self::render($row, $params, $tree, $loaded, $serializer))->values()->all();
    }

    // ------------------------------------------------------------------------------ the tree

    /**
     * The populate parameter as key → that key's own parameters, keeping only relations the caller
     * may read: Strapi drops the others silently. $at is the relation path it sits under.
     *
     * @return array<string, array>
     */
    private static function tree(mixed $populate, string $serializer, ?Authenticatable $viewer, ?string $at): array
    {
        if ($populate === null || $populate === '' || $populate === []) {
            return [];
        }
        if ($populate === '*') {
            $tree = array_fill_keys($serializer::COMPONENTS, []);
            foreach ($serializer::FIELDS as $key => $field) {
                if (isset($field['relation']) && StrapiQuery::readable($field, $viewer)) {
                    $tree[$key] = [];
                }
            }

            return $tree;
        }
        if (is_string($populate)) {
            $populate = array_map('trim', explode(',', $populate));
        }
        if (! is_array($populate)) {
            throw StrapiError::validation('Invalid populate parameter. Expected a string, an array of strings, a populate object');
        }
        $tree = [];
        if (array_is_list($populate)) {
            foreach ($populate as $item) {
                if (! is_string($item)) {
                    throw StrapiError::validation('Invalid populate parameter. Expected a string, an array of strings, a populate object');
                }
                self::dotted($tree, $item, $serializer, $viewer, $at);
            }

            return $tree;
        }
        foreach ($populate as $key => $value) {
            $key = (string) $key;
            self::known($key, $serializer, self::join($at, null), $at);
            if ($value === false || $value === 'false') {
                continue;
            }
            $sub = is_array($value) ? array_intersect_key($value, array_flip(self::PARAMS)) : [];
            if (self::allowed($key, $serializer, $viewer)) {
                $sub['tree'] = self::subtree($key, $sub, $serializer, $viewer, $at);
                $tree[$key] = $sub;
            }
        }

        return $tree;
    }

    /** 'books.genres' → books populated, with genres populated inside it. */
    private static function dotted(array &$tree, string $item, string $serializer, ?Authenticatable $viewer, ?string $at): void
    {
        [$key, $rest] = array_pad(explode('.', $item, 2), 2, null);
        self::known($key, $serializer, self::join($at, $key), $at);
        if (! self::allowed($key, $serializer, $viewer)) {
            return;
        }
        $sub = $tree[$key] ?? ['tree' => []];
        if ($rest !== null && isset($serializer::FIELDS[$key]['relation'])) {
            self::dotted($sub['tree'], $rest, $serializer::FIELDS[$key]['serializer'], $viewer, self::join($at, $key));
        }
        $tree[$key] = $sub;
    }

    private static function subtree(string $key, array $sub, string $serializer, ?Authenticatable $viewer, ?string $at): array
    {
        $field = $serializer::FIELDS[$key] ?? [];
        if (! isset($field['relation']) || ! array_key_exists('populate', $sub)) {
            return [];
        }

        return self::tree($sub['populate'], $field['serializer'], $viewer, self::join($at, $key));
    }

    /** A key populate may name: a component or a relation. $path is what the error reports. */
    private static function known(string $key, string $serializer, ?string $path, ?string $at): void
    {
        if (! in_array($key, $serializer::COMPONENTS, true) && ! isset($serializer::FIELDS[$key]['relation'])) {
            throw StrapiError::invalidKey($key, $path ?? $at, 'populate');
        }
    }

    private static function allowed(string $key, string $serializer, ?Authenticatable $viewer): bool
    {
        $field = $serializer::FIELDS[$key] ?? [];

        return ! isset($field['relation']) || StrapiQuery::readable($field, $viewer);
    }

    private static function join(?string $a, ?string $b): ?string
    {
        $parts = array_filter([$a, $b], fn ($p) => $p !== null && $p !== '');

        return $parts === [] ? null : implode('.', $parts);
    }

    // ------------------------------------------------------------------------------ loading

    /**
     * Eager-loads one relation for every row, inside the target's read scope and the populate
     * entry's filters and sort, then renders each distinct target row once.
     *
     * @return array{count: bool, links: array<int|string, list<int|string>|int>, wires: array<int|string, array>}
     */
    private static function load(Collection $rows, string $serializer, array $relation, array $sub, ?Authenticatable $viewer, string $at, bool $published, ?string $cohort): array
    {
        $narrow = function (Builder $query) use ($relation, $sub, $viewer, $at, $published, $cohort): void {
            StrapiQuery::scope($query, $viewer);
            if ($cohort !== null && ($relation['draftPublish'] ?? false)) {
                StrapiDocuments::cohort($query, $cohort, $published);
            }
            StrapiQuery::filter($query, $sub, $relation['serializer']::FIELDS, $viewer, $at);
            StrapiQuery::order($query, $sub['sort'] ?? null, $relation['serializer']::FIELDS, $viewer);
        };
        $count = self::counted($sub);
        // A to-many lists its links in the order they were made unless the entry sorts it.
        $order = ! $count && ! isset($sub['sort']) ? ($relation['order'] ?? null) : null;
        $links = $relation['kind'] === 'localizations'
            ? self::localizations($rows, $relation['draftPublish'] ? $published : null, $narrow, $count)
            : match (self::projection($relation, $serializer::DRAFT_PUBLISH, $published)) {
                'forward' => self::forward($rows, $relation, $narrow, $count, $order),
                'parent' => self::parent($rows, $relation, $narrow, $count, $order),
                default => self::linked($rows, $relation, $relation['draftPublish'] ? $published : null, $narrow, $count, $order),
            };
        if ($count) {
            return ['count' => true, 'links' => $links, 'wires' => []];
        }
        $targets = new Collection();
        $media = in_array($relation['kind'], ['mediaOne', 'mediaMany'], true);
        foreach ($links as $key => $linked) {
            $visible = $media ? $linked : array_values(array_filter($linked, fn (Model $target) => StrapiQuery::visible($target, $viewer)));
            foreach ($visible as $target) {
                $targets[$target->getKey()] = $target;
            }
            $links[$key] = array_map(fn (Model $target) => $target->getKey(), $visible);
        }
        $params = array_intersect_key($sub, array_flip(['fields']));
        $wires = self::rendered($targets->values(), $params, $sub['tree'] ?? [], $relation['serializer'], $viewer, $published, $cohort);

        return ['count' => false, 'links' => $links, 'wires' => array_combine($targets->keys()->all(), $wires) ?: []];
    }

    /**
     * How a relation's link reaches the version wanted. 'forward': a plain type's link to a
     * versioned target holds its draft, shown as its published version. 'parent': a plain target's
     * link to a versioned type holds the draft, so a published row reaches it through its draft.
     */
    private static function projection(array $relation, bool $versioned, bool $published): string
    {
        if (! $published) {
            return 'linked';
        }
        if ($relation['holder'] === 'self' && ! $versioned && $relation['draftPublish']) {
            return 'forward';
        }

        return $relation['holder'] === 'target' && $versioned && ! $relation['draftPublish'] ? 'parent' : 'linked';
    }

    /**
     * The relation as stored, narrowed to one status when the target is versioned.
     *
     * @return array<int|string, list<Model>|int> row key → its targets, or their number when counted
     */
    private static function linked(Collection $rows, array $relation, ?bool $status, Closure $narrow, bool $count, ?string $order = null): array
    {
        $name = $relation['relation'];
        // load() hands the closure the relation, loadCount() the target's own query.
        $media = in_array($relation['kind'], ['mediaOne', 'mediaMany'], true);
        $constrain = function (Relation|Builder $query) use ($status, $narrow, $media, $order): void {
            // A media field lists its files in the order they were given, before any sort.
            if ($media && $query instanceof BelongsToMany) {
                $query->orderByPivot('order');
            }
            if ($order !== null && $query instanceof Relation) {
                StrapiLinkOrder::sort($query, $query instanceof BelongsToMany ? $query->qualifyPivotColumn($order) : $query->getRelated()->qualifyColumn($order));
            }
            $builder = $query instanceof Relation ? $query->getQuery() : $query;
            if ($status !== null) {
                StrapiDocuments::withStatus($builder, $status);
            }
            $narrow($builder);
        };
        $links = [];
        if ($count) {
            $rows->loadCount([$name => $constrain]);
            foreach ($rows as $row) {
                $links[$row->getKey()] = (int) $row->getAttribute("{$name}_count");
            }

            return $links;
        }
        $rows->load([$name => $constrain]);
        foreach ($rows as $row) {
            $links[$row->getKey()] = self::targets($row, $name);
        }

        return $links;
    }

    /** @return array<int|string, list<Model>|int> */
    private static function forward(Collection $rows, array $relation, Closure $narrow, bool $count, ?string $order): array
    {
        $name = $relation['relation'];
        $rows->load([$name => function (Relation $query) use ($order): void {
            if ($order !== null) {
                StrapiLinkOrder::sort($query, $query instanceof BelongsToMany ? $query->qualifyPivotColumn($order) : $query->getRelated()->qualifyColumn($order));
            }
        }]);
        $columns = $relation['localized'] ? ['document_id', 'locale'] : ['document_id'];
        $drafts = [];
        foreach ($rows as $row) {
            $drafts[$row->getKey()] = self::targets($row, $name);
        }
        $query = $relation['model']::query();
        $all = array_merge([], ...array_values($drafts));
        $query->whereIn($query->qualifyColumn('document_id'), array_values(array_unique(array_map(fn (Model $draft) => $draft->getAttribute('document_id'), $all))));
        StrapiDocuments::withStatus($query, true);
        $narrow($query);
        $published = $query->get();
        $links = [];
        foreach ($drafts as $key => $linkedDrafts) {
            $versions = array_map(fn (Model $draft) => StrapiDocuments::versionKey($draft, $columns), $linkedDrafts);
            $linked = $published->filter(fn (Model $target) => in_array(StrapiDocuments::versionKey($target, $columns), $versions, true))->values()->all();
            if ($order !== null) {
                // In the drafts' link order, not the published query's.
                usort($linked, fn (Model $a, Model $b) => array_search(StrapiDocuments::versionKey($a, $columns), $versions, true) <=> array_search(StrapiDocuments::versionKey($b, $columns), $versions, true));
            }
            $links[$key] = $count ? count($linked) : $linked;
        }

        return $links;
    }

    /** @return array<int|string, list<Model>|int> */
    private static function parent(Collection $rows, array $relation, Closure $narrow, bool $count, ?string $order): array
    {
        $first = $rows->first();
        if ($first === null) {
            return [];
        }
        $query = $first->newQuery();
        $drafts = StrapiDocuments::withStatus($query->whereIn($query->qualifyColumn('document_id'), $rows->pluck('document_id')->unique()->values()->all()), false)->get();
        $byDraft = self::linked($drafts, $relation, null, $narrow, $count, $order);
        // A document keeps one draft per locale.
        $version = fn (Model $row): string => $row->getAttribute('document_id') . '|' . $row->getAttribute('locale');
        $draftOf = $drafts->mapWithKeys(fn (Model $draft) => [$version($draft) => $draft->getKey()])->all();
        $links = [];
        foreach ($rows as $row) {
            $draft = $draftOf[$version($row)] ?? null;
            $links[$row->getKey()] = $draft === null ? ($count ? 0 : []) : $byDraft[$draft];
        }

        return $links;
    }

    /**
     * Each row's document in its other locales, of the status asked for when it has versions.
     *
     * @return array<int|string, list<Model>|int>
     */
    private static function localizations(Collection $rows, ?bool $status, Closure $narrow, bool $count): array
    {
        $first = $rows->first();
        if ($first === null) {
            return [];
        }
        $query = $first->newQuery();
        $query->whereIn($query->qualifyColumn('document_id'), $rows->pluck('document_id')->unique()->values()->all());
        if ($status !== null) {
            StrapiDocuments::withStatus($query, $status);
        }
        $narrow($query);
        $siblings = $query->get();
        $links = [];
        foreach ($rows as $row) {
            $linked = $siblings->filter(fn (Model $sibling) => $sibling->getAttribute('document_id') === $row->getAttribute('document_id')
                && $sibling->getAttribute('locale') !== $row->getAttribute('locale'))->values()->all();
            $links[$row->getKey()] = $count ? count($linked) : $linked;
        }

        return $links;
    }

    /** @return list<Model> */
    private static function targets(Model $row, string $name): array
    {
        $value = $row->getRelation($name);
        if ($value instanceof Collection) {
            return $value->all();
        }

        return $value instanceof Model ? [$value] : [];
    }

    private static function counted(array $sub): bool
    {
        return in_array($sub['count'] ?? null, [true, 'true', '1', 1], true);
    }

    // ---------------------------------------------------------------------------- rendering

    private static function render(Model $row, array $params, array $tree, array $loaded, string $serializer): array
    {
        $wire = $serializer::toWire($row);
        $always = (bool) config('camis.rest.always_populate_components', false);
        foreach ($serializer::COMPONENTS as $key) {
            if (isset($serializer::ZONES[$key]) && (array_key_exists($key, $tree) || $always)) {
                $wire[$key] = self::zone($wire[$key] ?? [], $key, $tree[$key] ?? [], $serializer);
            } elseif (array_key_exists($key, $tree)) {
                $wire[$key] = self::component($wire[$key] ?? null, $key, $tree[$key], $serializer);
            } elseif (! $always) {
                unset($wire[$key]);
            }
        }
        $wire = StrapiQuery::select($wire, $params, $serializer::FIELDS);
        foreach ($loaded as $key => $result) {
            $linked = $result['links'][$row->getKey()] ?? [];
            if ($result['count']) {
                $wire[$key] = ['count' => (int) $linked];
                continue;
            }
            $wires = array_map(fn (int|string $target) => $result['wires'][$target], $linked);
            $kind = $serializer::FIELDS[$key]['kind'];
            $wire[$key] = in_array($kind, ['hasMany', 'belongsToMany', 'localizations', 'mediaMany'], true) ? $wires : ($wires[0] ?? null);
        }

        return $wire;
    }

    /**
     * A populated component: null or [] when empty, as Strapi sends it, without the nested
     * components and media its own populate does not name, narrowed by its fields.
     */
    private static function component(mixed $value, string $key, array $sub, string $serializer): ?array
    {
        $repeatable = isset($serializer::FIELDS[$key]['component']);
        if ($value === null) {
            return $repeatable ? [] : null;
        }
        $own = self::nestedKeys($repeatable ? $serializer::FIELDS[$key]['fields'] : self::within($key, $serializer));
        $value = $repeatable
            ? array_map(fn (array $item) => self::inside($item, $sub['populate'] ?? null, $own), $value)
            : self::inside($value, $sub['populate'] ?? null, $own);
        if (! array_key_exists('fields', $sub)) {
            return $value;
        }
        $wanted = is_string($sub['fields']) ? array_map('trim', explode(',', $sub['fields'])) : (array) $sub['fields'];
        $known = $repeatable ? array_keys($serializer::FIELDS[$key]['fields']) : self::embedded($key, $serializer);
        foreach ($wanted as $field) {
            if (! is_string($field) || ! in_array($field, $known, true)) {
                throw StrapiError::invalidKey((string) $field, $key, 'fields');
            }
        }
        $keep = array_flip($wanted);

        return $repeatable
            ? array_map(fn (array $item) => array_intersect_key($item, $keep), $value)
            : array_intersect_key($value, $keep);
    }

    /**
     * A populated dynamic zone: its items in order, each component inside an item left out unless
     * the zone's populate names it. On keeps only the components it names, each with its own
     * fields and populate.
     */
    private static function zone(array $items, string $key, array $sub, string $serializer): array
    {
        $members = $serializer::ZONES[$key];
        $on = is_array($sub['on'] ?? null) ? $sub['on'] : null;
        $zone = [];
        foreach ($items as $item) {
            $uid = $item['__component'];
            $own = $members[$uid]['components'] ?? [];
            if ($on === null) {
                $zone[] = self::inside($item, $sub['populate'] ?? null, $own);
            } elseif (array_key_exists($uid, $on) && ! in_array($on[$uid], [false, 'false'], true)) {
                $fragment = is_array($on[$uid]) ? $on[$uid] : [];
                $zone[] = self::inside(self::fields($item, $fragment['fields'] ?? null, $own), $fragment['populate'] ?? null, $own);
            }
        }

        return $zone;
    }

    /** An item without the components and media of its own that $populate does not name. */
    private static function inside(array $item, mixed $populate, array $own): array
    {
        if ($populate === '*' || $populate === true || $populate === 'true') {
            return $item;
        }
        $named = match (true) {
            is_string($populate) => array_map('trim', explode(',', $populate)),
            is_array($populate) && array_is_list($populate) => $populate,
            is_array($populate) => array_keys($populate),
            default => [],
        };

        return array_diff_key($item, array_flip(array_diff($own, $named)));
    }

    /** A zone item narrowed to $fields, keeping its id, its component and its own components. */
    private static function fields(array $item, mixed $fields, array $own): array
    {
        if ($fields === null || $fields === '*') {
            return $item;
        }
        $wanted = is_string($fields) ? array_map('trim', explode(',', $fields)) : (array) $fields;

        return array_intersect_key($item, array_flip(['id', '__component', ...$own, ...$wanted]));
    }

    /** @return list<string> the scalar keys of an embedded component, relative to it */
    private static function embedded(string $key, string $serializer): array
    {
        return array_map(fn (string $path) => explode('.', $path)[0], array_keys(self::within($key, $serializer)));
    }

    /** An embedded component's entries in FIELDS, keyed by their paths relative to it. */
    private static function within(string $key, string $serializer): array
    {
        $fields = [];
        foreach ($serializer::FIELDS as $path => $field) {
            if (str_starts_with((string) $path, "{$key}.")) {
                $fields[substr((string) $path, strlen($key) + 1)] = $field;
            }
        }

        return $fields;
    }

    /** @return list<string> the keys inside a component that only its populate sends: its components and media */
    private static function nestedKeys(array $fields): array
    {
        $keys = [];
        foreach ($fields as $path => $field) {
            $segments = explode('.', (string) $path);
            if (count($segments) > 1 || isset($field['component']) || ($field['type'] ?? null) === 'media') {
                $keys[] = $segments[0];
            }
        }

        return array_values(array_unique($keys));
    }
}
`;

/**
 * Strapi 5's relation input on create and update: a documentId, a numeric id or an object holding
 * one; a list (which replaces the set); or `{ connect, disconnect, set }`. Every reference is
 * resolved within the caller's view of the target before anything is written, so a bad one fails
 * the whole request with Strapi's 400 and changes nothing.
 *
 * A to-many keeps the order its links were made in, and a connect's position (before, after,
 * start, end) places it, as `StrapiLinkOrder` writes it.
 *
 * A draft-and-publish target is linked through its draft, whichever version the reference names:
 * publishing maps the links onto published versions (`StrapiDocuments`). A documentId names a
 * target that keeps locales in the writer's locale, or its default one when the writer keeps none.
 */
export const emitStrapiRelations = (): string =>
  header +
  String.raw`
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
            if (! isset($relation['relation']) || $relation['kind'] === 'localizations' || ! array_key_exists($key, $data)) {
                continue;
            }
            if (! StrapiQuery::readable($relation, $viewer)) {
                throw StrapiError::validation("Invalid key {$key}", ['key' => $key, 'path' => $key, 'source' => 'body']);
            }
            // A target that keeps locales is linked in the writer's locale, else in its default one.
            $relation['locale'] = $relation['localized'] ? ($locale ?? StrapiLocales::default()) : null;
            $links[$key] = self::instruction($relation, $data[$key], $viewer);
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
            $target = self::single($row->getAttribute($column), $link);
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
`;
