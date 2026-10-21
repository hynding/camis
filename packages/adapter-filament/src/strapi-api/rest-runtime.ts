import { PHP_MARKER } from "../hooks/names";

const header = (namespace: string): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace ${namespace};\n`;

/**
 * Strapi 5's REST list parameters — `filters`, `sort`, `pagination`, `fields` — over an Eloquent
 * query. A port of the parts of strapi-php that a content API list request reaches
 * (`utils/query-params-transformer`, `utils/pagination`, `core-api/service/pagination`, the
 * `validate` visitors and `database/query/helpers/where`), so the same request means the same rows
 * and the same errors on both. The canonical check is `rest-query-vectors.json`, which passes
 * against strapi-php and against the generated app.
 *
 * One plain class with static methods: nothing is registered at boot, so FPM pays for it only on
 * the requests that list.
 */
// A project without roles passes a null viewer and checks nothing; with roles, null is a caller
// without a session, whom the gate and the scope answer for from the public role.
const viewerDoc = (secured: boolean): string =>
  secured
    ? ` * $viewer is the caller, null without a session: a relation's rows are reached only through the
 * target's read grant and its forUser scope, as on its own route.
 */`
    : ` * $viewer is the caller in a project with roles, and null in one without: a relation's rows are
 * then reached only through the target's read grant and its forUser scope, as on its own route.
 */`;
const unsecured = (secured: boolean): string =>
  secured ? "self::$unrestricted || " : "self::$unrestricted || $viewer === null || ";
const scopeBody = (secured: boolean): string =>
  secured
    ? `        if (! self::$unrestricted) {
            $query->forUser($viewer);
        }`
    : `        if (! self::$unrestricted && $viewer !== null) {
            $query->forUser($viewer);
        }`;

export const emitStrapiQuery = (secured = false): string =>
  header("App\\Support") +
  String.raw`
use Carbon\CarbonImmutable;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Query\Expression;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Gate;

/**
 * $fields is a serializer's FIELDS map: a wire path ('title', 'price.currency') to
 * ['column' => ..., 'type' => <IR field type>], a repeatable component to
 * ['component' => <child relation>, 'fields' => <the child's own map>], or a relation to
 * ['relation' => <Eloquent relation>, 'kind' => ..., 'model' => ..., 'serializer' => ...].
 *
${viewerDoc(secured)}
final class StrapiQuery
{
    private const ATTRIBUTE_OPERATORS = [
        '$not', '$in', '$notIn', '$eq', '$eqi', '$ne', '$nei', '$gt', '$gte', '$lt', '$lte',
        '$null', '$notNull', '$between', '$startsWith', '$endsWith', '$startsWithi', '$endsWithi',
        '$contains', '$notContains', '$containsi', '$notContainsi',
    ];

    private const GROUP_OPERATORS = ['$and', '$or'];

    private const LIKE_SPECIAL_CHARS = ['\\', '%', '_'];

    /** @return array{rows: Collection, pagination: array<string, int>} */
    public static function find(Builder $query, array $params, array $fields, ?Authenticatable $viewer = null): array
    {
        self::filter($query, $params, $fields, $viewer, null);
        $pagination = is_array($params['pagination'] ?? null) ? $params['pagination'] : [];
        ['start' => $start, 'limit' => $limit] = self::paginationInfo($pagination);
        // Counted before ordering: Postgres rejects an ORDER BY on an aggregate without GROUP BY.
        $total = self::shouldCount($pagination) ? (clone $query)->count() : null;
        self::sort($query, $params['sort'] ?? null, $fields, $viewer);

        if ($limit >= 0) {
            $query->limit($limit);
        } elseif ($start > 0) {
            $query->limit(PHP_INT_MAX); // MySQL accepts no OFFSET without a LIMIT
        }
        if ($start > 0) {
            $query->offset($start);
        }

        return [
            'rows' => $query->get(),
            'pagination' => self::paginationResponse($start, $limit, $total, self::isPaged($pagination)),
        ];
    }

    /** The filters parameter; $at is the populate path it sits under, for error messages. */
    public static function filter(Builder $query, array $params, array $fields, ?Authenticatable $viewer, ?string $at): void
    {
        if (! array_key_exists('filters', $params)) {
            return;
        }
        if (! is_array($params['filters'])) {
            throw StrapiError::validation('The filters parameter must be an object or an array');
        }
        self::where($query, $params['filters'], $fields, null, $viewer, $at);
    }

    /** The sort parameter, or id order when there is none. */
    public static function order(Builder $query, mixed $sort, array $fields, ?Authenticatable $viewer): void
    {
        self::sort($query, $sort, $fields, $viewer);
    }

    /** Set while unrestricted() runs. */
    private static bool $unrestricted = false;

    /**
     * Reads as no caller: every row and every relation, as Strapi populates the entry it sends a
     * webhook whoever made the change.
     */
    public static function unrestricted(\Closure $read): mixed
    {
        $was = self::$unrestricted;
        self::$unrestricted = true;
        try {
            return $read();
        } finally {
            self::$unrestricted = $was;
        }
    }

    /** Whether the caller may read the target of a FIELDS relation entry at all. */
    public static function readable(array $relation, ?Authenticatable $viewer): bool
    {
        return ${unsecured(secured)}Gate::forUser($viewer)->allows('viewAny', $relation['model']);
    }

    /** Whether the caller may see one row of a relation's target. */
    public static function visible(mixed $row, ?Authenticatable $viewer): bool
    {
        return ${unsecured(secured)}Gate::forUser($viewer)->allows('view', $row);
    }

    /** Narrows a target's query to the rows the caller's grants let it list. */
    public static function scope(mixed $query, ?Authenticatable $viewer): void
    {
${scopeBody(secured)}
    }

    /** Keeps the scalars the fields parameter names, plus id and documentId; components stay. */
    public static function select(array $wire, array $params, array $fields): array
    {
        if (! array_key_exists('fields', $params) || $params['fields'] === '*') {
            return $wire;
        }
        $wanted = $params['fields'];
        if (is_string($wanted)) {
            $wanted = array_map('trim', explode(',', $wanted));
        }
        if (! is_array($wanted) || ! array_is_list($wanted) || array_filter($wanted, fn ($f) => ! is_string($f)) !== []) {
            throw StrapiError::validation('Invalid fields parameter. Expected a string or an array of strings');
        }
        foreach ($wanted as $key) {
            if (! isset($fields[$key]['column']) || str_contains($key, '.')) {
                // Strapi names the path only when the key is a component it refused to select.
                $isComponent = isset($fields[$key]['component']) || isset($fields[$key]['zone']) || self::isComponent($fields, $key);
                throw StrapiError::invalidKey($key, $isComponent ? $key : null, 'fields');
            }
        }
        $keep = array_flip(['id', 'documentId', ...$wanted]);
        foreach (array_keys($wire) as $key) {
            if (isset($fields[$key]['column']) && ! isset($keep[$key])) {
                unset($wire[$key]);
            }
        }

        return $wire;
    }

    // -------------------------------------------------------------------------------- filters

    /**
     * One level of a filters object. $path is the wire path of the component it sits in; $at is
     * the relation path it was reached through, which only error messages name.
     */
    private static function where(Builder $query, array $filters, array $fields, ?string $path, ?Authenticatable $viewer, ?string $at): void
    {
        if (array_is_list($filters)) {
            foreach ($filters as $item) {
                if (is_array($item)) {
                    $query->where(fn (Builder $q) => self::where($q, $item, $fields, $path, $viewer, $at));
                }
            }

            return;
        }

        foreach ($filters as $key => $value) {
            $key = (string) $key;
            if (in_array($key, self::GROUP_OPERATORS, true)) {
                self::group($query, $key, $value, $fields, $path, $viewer, $at);
                continue;
            }
            if ($key === '$not') {
                if (is_array($value)) {
                    $query->whereNot(fn (Builder $q) => self::where($q, $value, $fields, $path, $viewer, $at));
                }
                continue;
            }
            $wirePath = $path === null ? $key : "{$path}.{$key}";
            $errorPath = self::join($at, $path);
            $field = $fields[$wirePath] ?? null;
            if (isset($field['column'])) {
                self::attribute($query, $query->qualifyColumn($field['column']), $field['type'], $value, self::join($at, $wirePath));
            } elseif (isset($field['component'])) {
                if (is_array($value)) {
                    $query->whereHas($field['component'], fn (Builder $q) => self::where($q, $value, $field['fields'], null, $viewer, self::join($at, $wirePath)));
                }
            } elseif (isset($field['zone'])) {
                throw StrapiError::invalidKey($key, self::join($at, $wirePath), 'filters');
            } elseif (isset($field['relation'])) {
                if (! self::readable($field, $viewer)) {
                    throw StrapiError::invalidKey($key, self::join($at, $wirePath), 'filters');
                }
                self::relation($query, $field, $value, $viewer, self::join($at, $wirePath));
            } elseif (self::isComponent($fields, $wirePath)) {
                if (is_array($value)) {
                    self::where($query, $value, $fields, $wirePath, $viewer, $at);
                }
            } else {
                throw StrapiError::invalidKey($key, $errorPath, 'filters');
            }
        }
    }

    /**
     * A filter on a relation: $null/$notNull on the link itself, a bare value or list on the
     * target's id, anything else on the target's own fields — always within the caller's view.
     */
    private static function relation(Builder $query, array $relation, mixed $value, ?Authenticatable $viewer, string $at): void
    {
        $within = fn (Builder $q) => self::scope($q, $viewer);
        if (! is_array($value) || array_is_list($value)) {
            $ids = array_map(fn ($v) => self::cast('integer', $v), is_array($value) ? $value : [$value]);
            $query->whereHas($relation['relation'], function (Builder $q) use ($within, $ids): void {
                $within($q);
                $q->whereIn($q->qualifyColumn('id'), $ids);
            });

            return;
        }
        $nested = $value;
        foreach (['$null' => true, '$notNull' => false] as $operator => $missing) {
            if (! array_key_exists($operator, $nested)) {
                continue;
            }
            self::truthy($nested[$operator]) === $missing
                ? $query->whereDoesntHave($relation['relation'], $within)
                : $query->whereHas($relation['relation'], $within);
            unset($nested[$operator]);
        }
        if ($nested !== []) {
            $query->whereHas($relation['relation'], function (Builder $q) use ($within, $nested, $relation, $viewer, $at): void {
                $within($q);
                self::where($q, $nested, $relation['serializer']::FIELDS, null, $viewer, $at);
            });
        }
    }

    private static function join(?string $a, ?string $b): ?string
    {
        $parts = array_filter([$a, $b], fn ($p) => $p !== null && $p !== '');

        return $parts === [] ? null : implode('.', $parts);
    }

    private static function group(Builder $query, string $operator, mixed $value, array $fields, ?string $path, ?Authenticatable $viewer, ?string $at): void
    {
        if (! is_array($value)) {
            return;
        }
        $query->where(function (Builder $q) use ($operator, $value, $fields, $path, $viewer, $at): void {
            foreach ($value as $item) {
                if (! is_array($item)) {
                    continue;
                }
                $nested = fn (Builder $sub) => self::where($sub, $item, $fields, $path, $viewer, $at);
                $operator === '$or' ? $q->orWhere($nested) : $q->where($nested);
            }
        });
    }

    private static function isComponent(array $fields, string $wirePath): bool
    {
        foreach (array_keys($fields) as $candidate) {
            if (str_starts_with($candidate, "{$wirePath}.")) {
                return true;
            }
        }

        return false;
    }

    private static function attribute(Builder $query, string $column, string $type, mixed $value, string $wirePath): void
    {
        if (! is_array($value)) {
            $value === null ? $query->whereNull($column) : $query->where($column, self::cast($type, $value));

            return;
        }
        if (array_is_list($value)) {
            $query->whereIn($column, array_map(fn ($v) => self::cast($type, $v), $value));

            return;
        }
        foreach ($value as $operator => $operand) {
            $operator = (string) $operator;
            if (in_array($operator, self::GROUP_OPERATORS, true) && is_array($operand)) {
                $query->where(function (Builder $q) use ($operator, $operand, $column, $type, $wirePath): void {
                    foreach ($operand as $item) {
                        $nested = fn (Builder $sub) => self::attribute($sub, $column, $type, $item, $wirePath);
                        $operator === '$or' ? $q->orWhere($nested) : $q->where($nested);
                    }
                });
                continue;
            }
            if (! in_array($operator, self::ATTRIBUTE_OPERATORS, true)) {
                throw StrapiError::invalidKey($operator, $wirePath, 'filters');
            }
            self::operator($query, $column, $type, $operator, $operand, $wirePath);
        }
    }

    private static function operator(Builder $query, string $column, string $type, string $operator, mixed $value, string $wirePath): void
    {
        $wrapped = $query->getQuery()->getGrammar()->wrap($column);
        $lower = $query->getConnection()->getDriverName() === 'pgsql' ? "LOWER(CAST({$wrapped} AS VARCHAR))" : "LOWER({$wrapped})";
        // SQLite has no default LIKE escape character; MySQL and Postgres default to a backslash.
        $escape = $query->getConnection()->getDriverName() === 'sqlite' ? " ESCAPE '\\'" : '';
        $list = fn (mixed $v): array => array_map(fn ($x) => self::cast($type, $x), is_array($v) ? array_values($v) : [$v]);

        match ($operator) {
            '$not' => $query->whereNot(fn (Builder $q) => self::attribute($q, $column, $type, $value, $wirePath)),
            '$in' => $query->whereIn($column, $list($value)),
            '$notIn' => $query->whereNotIn($column, $list($value)),
            '$eq' => $value === null ? $query->whereNull($column) : $query->where($column, self::cast($type, $value)),
            '$ne' => $value === null ? $query->whereNotNull($column) : $query->where($column, '<>', self::cast($type, $value)),
            '$eqi' => $value === null ? $query->whereNull($column) : $query->whereRaw("{$lower} = LOWER(?)", [self::stringify($value)]),
            '$nei' => $value === null ? $query->whereNotNull($column) : $query->whereRaw("{$lower} <> LOWER(?)", [self::stringify($value)]),
            '$gt' => $query->where($column, '>', self::cast($type, $value)),
            '$gte' => $query->where($column, '>=', self::cast($type, $value)),
            '$lt' => $query->where($column, '<', self::cast($type, $value)),
            '$lte' => $query->where($column, '<=', self::cast($type, $value)),
            '$null' => self::truthy($value) ? $query->whereNull($column) : $query->whereNotNull($column),
            '$notNull' => self::truthy($value) ? $query->whereNotNull($column) : $query->whereNull($column),
            '$between' => $query->whereBetween($column, array_slice(array_pad($list($value), 2, null), 0, 2)),
            '$startsWith' => $query->whereRaw("{$wrapped} LIKE ?{$escape}", [self::like($value).'%']),
            '$startsWithi' => $query->whereRaw("{$lower} LIKE LOWER(?){$escape}", [self::like($value).'%']),
            '$endsWith' => $query->whereRaw("{$wrapped} LIKE ?{$escape}", ['%'.self::like($value)]),
            '$endsWithi' => $query->whereRaw("{$lower} LIKE LOWER(?){$escape}", ['%'.self::like($value)]),
            '$contains' => $query->whereRaw("{$wrapped} LIKE ?{$escape}", ['%'.self::like($value).'%']),
            '$notContains' => $query->whereRaw("{$wrapped} NOT LIKE ?{$escape}", ['%'.self::like($value).'%']),
            '$containsi' => $query->whereRaw("{$lower} LIKE LOWER(?){$escape}", ['%'.self::like($value).'%']),
            '$notContainsi' => $query->whereRaw("{$lower} NOT LIKE LOWER(?){$escape}", ['%'.self::like($value).'%']),
        };
    }

    /** A query-string value as the column stores it: the conversion Strapi's database layer does. */
    private static function cast(string $type, mixed $value): mixed
    {
        if (! is_string($value) && ! is_int($value) && ! is_float($value) && ! is_bool($value)) {
            return $value;
        }

        return match ($type) {
            'boolean' => self::truthy($value),
            'integer' => is_numeric($value) ? (int) $value : $value,
            'float', 'decimal' => is_numeric($value) ? (float) $value : $value,
            'date' => self::parseDate($value)?->format('Y-m-d') ?? $value,
            'dateTime', 'timestamp' => self::parseDate($value)?->utc()->format('Y-m-d H:i:s') ?? $value,
            default => $value,
        };
    }

    private static function parseDate(mixed $value): ?CarbonImmutable
    {
        if (! is_string($value) || $value === '') {
            return null;
        }
        try {
            return CarbonImmutable::parse($value);
        } catch (\Throwable) {
            return null;
        }
    }

    private static function like(mixed $value): string
    {
        $escaped = self::stringify($value);
        foreach (self::LIKE_SPECIAL_CHARS as $char) {
            $escaped = str_replace($char, '\\'.$char, $escaped);
        }

        return $escaped;
    }

    private static function stringify(mixed $value): string
    {
        if (is_bool($value)) {
            return $value ? 'true' : 'false';
        }

        return is_scalar($value) ? (string) $value : (string) json_encode($value);
    }

    private static function truthy(mixed $value): bool
    {
        return ! in_array($value, [false, 0, '', '0', 'false', 'f', null], true);
    }

    // ----------------------------------------------------------------------------------- sort

    private static function sort(Builder $query, mixed $sort, array $fields, ?Authenticatable $viewer): void
    {
        $orders = self::sortOrders($sort);
        if ($orders === []) {
            $query->orderBy($query->qualifyColumn('id'));

            return;
        }
        foreach ($orders as [$path, $direction]) {
            $field = $fields[$path] ?? null;
            $head = explode('.', $path, 2);
            if (! isset($field) && isset($head[1], $fields[$head[0]]['relation'])) {
                self::sortByRelation($query, $fields[$head[0]], $head[0], $head[1], $direction, $viewer);
                continue;
            }
            if (isset($field['zone'])) {
                throw StrapiError::invalidKey($path, $path, 'sort');
            }
            if (isset($field['component']) || isset($field['relation']) || (! isset($field['column']) && self::isComponent($fields, $path))) {
                // Strapi reads 'price:asc' on a component as { price: 'asc' } and rejects 'asc'.
                throw StrapiError::invalidKey($direction, $path, 'sort');
            }
            if (! isset($field['column'])) {
                $parent = str_contains($path, '.') ? substr($path, 0, (int) strrpos($path, '.')) : null;
                $key = $parent === null ? $path : substr($path, strlen($parent) + 1);
                throw StrapiError::invalidKey($key, $parent, 'sort');
            }
            $query->orderBy($query->qualifyColumn($field['column']), strtolower($direction));
        }
    }

    /**
     * 'author.name:desc': ordered by a correlated subquery on the target, so the row count never
     * changes. A to-many relation orders by its smallest value ascending and its largest
     * descending, the row a join would put first.
     */
    private static function sortByRelation(Builder $query, array $relation, string $key, string $rest, string $direction, ?Authenticatable $viewer): void
    {
        if (! self::readable($relation, $viewer)) {
            // Strapi rejects the relation itself, whatever its target's key, as filters do.
            throw StrapiError::invalidKey($key, $key, 'sort');
        }
        $column = $relation['serializer']::FIELDS[$rest]['column'] ?? null;
        if ($column === null) {
            $parent = str_contains($rest, '.') ? $key.'.'.substr($rest, 0, (int) strrpos($rest, '.')) : $key;
            throw StrapiError::invalidKey(str_contains($rest, '.') ? substr($rest, (int) strrpos($rest, '.') + 1) : $rest, $parent, 'sort');
        }
        $eloquent = $query->getModel()->{$relation['relation']}();
        $target = $eloquent->getRelated()->newQuery();
        $wrapped = $query->getQuery()->getGrammar()->wrap($target->qualifyColumn($column));
        $aggregate = strtolower($direction) === 'desc' ? 'max' : 'min';
        $sub = $eloquent->getRelationExistenceQuery($target, $query, new Expression("{$aggregate}({$wrapped})"));
        self::scope($sub, $viewer);
        $query->orderBy($sub->toBase(), strtolower($direction));
    }

    /** @return list<array{0: string, 1: string}> wire path and direction, in order */
    private static function sortOrders(mixed $sort): array
    {
        if ($sort === null) {
            return [];
        }
        if (is_string($sort)) {
            return self::stringSort($sort);
        }
        if (! is_array($sort)) {
            throw StrapiError::validation('Invalid sort parameter. Expected a string, an array of strings, a sort object or an array of sort objects');
        }
        if (! array_is_list($sort)) {
            return self::objectSort($sort, null);
        }
        $orders = [];
        foreach ($sort as $item) {
            if (is_string($item)) {
                array_push($orders, ...self::stringSort($item));
            } elseif (is_array($item) && ! array_is_list($item)) {
                array_push($orders, ...self::objectSort($item, null));
            } else {
                throw StrapiError::validation('Invalid sort parameter. Expected a string, an array of strings, a sort object or an array of sort objects');
            }
        }

        return $orders;
    }

    /** @return list<array{0: string, 1: string}> */
    private static function stringSort(string $sort): array
    {
        $orders = [];
        foreach (explode(',', $sort) as $segment) {
            $parts = explode(':', trim($segment));
            $field = trim($parts[0]);
            if ($field === '') {
                continue;
            }
            $orders[] = [$field, self::direction(trim($parts[1] ?? 'asc'))];
        }

        return $orders;
    }

    /** @return list<array{0: string, 1: string}> */
    private static function objectSort(array $sort, ?string $path): array
    {
        $orders = [];
        foreach ($sort as $field => $order) {
            $wirePath = $path === null ? (string) $field : "{$path}.{$field}";
            if (is_array($order) && ! array_is_list($order)) {
                array_push($orders, ...self::objectSort($order, $wirePath));
            } elseif (is_string($order)) {
                if (trim($order) !== '') {
                    $orders[] = [$wirePath, self::direction(trim($order))];
                }
            } elseif ($order !== []) {
                throw StrapiError::validation('Invalid sort type expected object or string got '.get_debug_type($order));
            }
        }

        return $orders;
    }

    private static function direction(string $order): string
    {
        if (! in_array(strtolower($order), ['asc', 'desc'], true)) {
            throw StrapiError::validation('Invalid order. order can only be one of asc|desc|ASC|DESC');
        }

        return $order;
    }

    // ----------------------------------------------------------------------------- pagination

    private static function isPaged(array $pagination): bool
    {
        return array_key_exists('page', $pagination) || array_key_exists('pageSize', $pagination)
            || ! (array_key_exists('start', $pagination) || array_key_exists('limit', $pagination));
    }

    private static function shouldCount(array $pagination): bool
    {
        if (! array_key_exists('withCount', $pagination)) {
            return (bool) config('camis.rest.with_count', true);
        }
        $withCount = $pagination['withCount'];

        return match (true) {
            is_bool($withCount) => $withCount,
            $withCount === null => false,
            in_array($withCount, ['true', 't', '1', 1], true) => true,
            in_array($withCount, ['false', 'f', '0', 0], true) => false,
            default => throw StrapiError::validation('Invalid withCount parameter. Expected "t","1","true","false","0","f"'),
        };
    }

    /**
     * Strapi's withDefaultPagination: page/pageSize or start/limit to { start, limit }, where a
     * limit of -1 means "no limit" once maxLimit (0 or absent = none) has had its say.
     *
     * @return array{start: int, limit: int}
     */
    private static function paginationInfo(array $pagination): array
    {
        $defaultLimit = (int) config('camis.rest.default_limit', 25);
        $maxLimit = (int) config('camis.rest.max_limit', 100);
        $maxLimit = $maxLimit > 0 ? $maxLimit : -1;
        $page = $pagination['page'] ?? null;
        $pageSize = $pagination['pageSize'] ?? null;
        $start = $pagination['start'] ?? null;
        $limit = $pagination['limit'] ?? null;
        $usePage = $page !== null || $pageSize !== null;
        $useOffset = $start !== null || $limit !== null;

        if ($usePage && $useOffset) {
            throw new StrapiError(400, 'PaginationError', 'Cannot use both page & offset pagination in the same query');
        }
        if (! $usePage && ! $useOffset) {
            return self::validPagination(0, $defaultLimit, $maxLimit);
        }
        if ($useOffset) {
            $info = ['start' => (int) ($start ?? 0), 'limit' => (int) ($limit ?? $defaultLimit)];
        } else {
            $size = $pageSize !== null ? max(1, (int) $pageSize) : $defaultLimit;
            $pageLimit = self::validPagination(0, $size, $maxLimit)['limit'];
            $info = ['start' => ((int) ($page ?? 1) - 1) * $pageLimit, 'limit' => $pageLimit];
        }
        if ($info['limit'] === -1) {
            $info['limit'] = $maxLimit;
        }

        return self::validPagination($info['start'], $info['limit'], $maxLimit);
    }

    /** @return array{start: int, limit: int} */
    private static function validPagination(int $start, int $limit, int $maxLimit): array
    {
        $limit = $limit === -1 ? -1 : max($limit, 1);
        if ($maxLimit !== -1 && $limit >= $maxLimit) {
            $limit = $maxLimit;
        }

        return ['start' => max($start, 0), 'limit' => $limit];
    }

    /** @return array<string, int> */
    private static function paginationResponse(int $start, int $limit, ?int $total, bool $isPaged): array
    {
        $response = $isPaged
            ? [
                'page' => $limit > 0 ? intdiv($start, $limit) + 1 : 1,
                'pageSize' => $limit,
                'pageCount' => $limit > 0 ? (int) ceil(($total ?? 0) / $limit) : 0,
                'total' => $total ?? 0,
            ]
            : ['start' => $start, 'limit' => $limit, 'total' => $total ?? 0];
        if ($total === null) {
            unset($response['total'], $response['pageCount']);
        }

        return $response;
    }
}
`;

/** A Strapi application error (`@strapi/utils` errors): status, name, message and details. */
export const emitStrapiError = (): string =>
  header("App\\Support") +
  String.raw`
use RuntimeException;

final class StrapiError extends RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $name,
        string $message,
        public readonly array $details = [],
    ) {
        parent::__construct($message);
    }

    public static function validation(string $message, array $details = []): self
    {
        return new self(400, 'ValidationError', $message, $details);
    }

    /** Strapi's validate/utils throwInvalidKey, with the query parameter it was found in. */
    public static function invalidKey(string $key, ?string $path, string $param): self
    {
        $message = $path !== null && $path !== '' && $path !== $key ? "Invalid key {$key} at {$path}" : "Invalid key {$key}";

        return self::validation($message, ['key' => $key, 'path' => $path, 'source' => 'query', 'param' => $param]);
    }
}
`;

/**
 * Strapi 5 addresses documents by a 24-character `documentId`. Strapi mints a cuid2; this mints
 * the same shape (a lowercase letter, then 23 lowercase base-36 characters) from random_bytes,
 * which keeps the generated app free of a dependency for it. Filled on create unless the caller
 * set one, so an import can carry ids across from Strapi.
 */
export const emitHasDocumentId = (): string =>
  header("App\\Models\\Concerns") +
  String.raw`
trait HasDocumentId
{
    protected static function bootHasDocumentId(): void
    {
        static::creating(function ($model): void {
            if (($model->document_id ?? '') === '') {
                $model->document_id = self::newDocumentId();
            }
        });
    }

    public static function newDocumentId(): string
    {
        $alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
        $id = $alphabet[random_int(0, 25)];
        for ($i = 1; $i < 24; $i++) {
            $id .= $alphabet[random_int(0, 35)];
        }

        return $id;
    }
}
`;
