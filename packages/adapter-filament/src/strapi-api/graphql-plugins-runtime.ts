import { PHP_MARKER } from "../hooks/names";

/**
 * The GraphQL fields Strapi's own plugins add to the content API, over the generated REST
 * controllers as StrapiGraphql's content fields are: users-permissions' sign-in, users and roles,
 * i18n's locales and upload's files. graphql-plugin-vectors.json, recorded from strapi-php, is
 * the check.
 *
 * The REST plugin routes answer bare lists without pages, so a list is paged here; roles and
 * locales are few, and are filtered and sorted here too.
 */
export const emitStrapiGraphqlPlugins = (): string =>
  `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\GraphQL;\n` +
  String.raw`
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\LocaleController;
use App\Http\Controllers\Api\UploadController;
use App\Http\Controllers\Api\UserController;
use App\Models\User;
use App\Support\StrapiError;
use App\Support\StrapiQuery;
use App\Support\StrapiSessions;
use App\Support\StrapiUsers;
use GraphQL\Type\Definition\ResolveInfo;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Spatie\Permission\Models\Role;

final class StrapiGraphqlPlugins
{
    /** A plugin type's relations, which StrapiGraphql hands here. */
    public const RELATIONS = [
        'UsersPermissionsUser' => ['role'],
        'UsersPermissionsRole' => ['users', 'permissions'],
    ];

    private const USER = 'plugin::users-permissions.user';

    private const ROLE = 'plugin::users-permissions.role';

    public static function root(string $action, array $args, Request $request, ResolveInfo $info): mixed
    {
        [$plugin, $verb] = explode('.', $action, 2);

        return match ($plugin) {
            'auth' => self::auth($verb, $args, $request),
            'users' => self::users($verb, $args, $request, $info),
            'roles' => self::roles($verb, $args, $request, $info),
            'locales' => self::locales($verb, $args, $request, $info),
            default => self::files($verb, $args, $request, $info),
        };
    }

    /** A user's role, and a role's users and permissions. */
    public static function field(array $source, array $args, Request $request, ResolveInfo $info): mixed
    {
        $name = $info->fieldName;
        $key = str_ends_with($name, '_connection') ? substr($name, 0, -strlen('_connection')) : $name;
        if (! in_array($key, self::RELATIONS[$info->parentType->name], true)) {
            return $source[$name] ?? null;
        }
        if ($key === 'role') {
            self::readRoles($request, self::ROLE.'.find');

            return $source['role'] ?? null;
        }
        if ($key === 'permissions') {
            throw StrapiError::validation("A role's permissions are its grants in the project's roles, which GraphQL does not list");
        }
        StrapiGraphql::authorize($request, self::USER.'.find');
        $params = self::query($args, $info);
        $query = User::role((string) $source['type']);
        StrapiQuery::filter($query, $params, StrapiUsers::FIELDS, $request->user(), 'users');
        StrapiQuery::order($query, $params['sort'] ?? null, StrapiUsers::FIELDS, $request->user());
        $role = array_diff_key($source, array_flip(['users', 'permissions']));
        $users = $query->get()->map(fn (User $user) => StrapiUsers::wire($user) + ['role' => $role])->all();
        $items = StrapiGraphql::page($users, $args['pagination'] ?? []);

        return $key === $name ? $items : ['nodes' => $items];
    }

    // ------------------------------------------------------------------------- users-permissions

    private static function auth(string $verb, array $args, Request $request): mixed
    {
        $auth = AuthController::class;
        switch ($verb) {
            case 'me':
                self::signedInOrToken($request);
                $me = StrapiGraphql::dispatch(UserController::class, 'me', [], $request);

                return self::withRoles([$me])[0] + ['role' => null];
            case 'login':
                $input = $args['input'];
                if (($input['provider'] ?? 'local') !== 'local') {
                    throw StrapiError::validation('Only the local provider signs in through GraphQL');
                }
                self::throttle($request);

                return self::session(StrapiGraphql::dispatch($auth, 'login', [], $request, ['identifier' => $input['identifier'], 'password' => $input['password']], [], false));
            case 'register':
                self::throttle($request);

                return self::session(StrapiGraphql::dispatch($auth, 'register', [], $request, $args['input'], [], false));
            case 'forgotPassword':
                self::throttle($request);

                return StrapiGraphql::dispatch($auth, 'forgotPassword', [], $request, $args, [], false);
            case 'resetPassword':
                self::throttle($request);

                return self::session(StrapiGraphql::dispatch($auth, 'resetPassword', [], $request, $args, [], false));
            case 'changePassword':
                self::signedInOrToken($request);

                return self::session(StrapiGraphql::dispatch($auth, 'changePassword', [], $request, $args));
            default:
                // Strapi's GraphQL answers a confirmation with a session where REST redirects.
                $user = User::query()->where('confirmation_token', (string) $args['confirmation'])->first();
                StrapiGraphql::dispatch($auth, 'emailConfirmation', ['confirmation' => $args['confirmation']], $request, null, [], false);

                return $user === null ? null : self::session(StrapiSessions::registered($request, $user->refresh()));
        }
    }

    private static function users(string $verb, array $args, Request $request, ResolveInfo $info): mixed
    {
        $users = UserController::class;
        switch ($verb) {
            case 'find':
            case 'connection':
                return self::listed($verb, self::withRoles(StrapiGraphql::dispatch($users, 'find', self::query($args, $info), $request) ?? []), $args);
            case 'findOne':
                $rows = StrapiGraphql::dispatch($users, 'find', self::byDocumentId($args), $request, null, [], self::USER.'.findOne') ?? [];

                return self::withRoles($rows)[0] ?? null;
            case 'create':
                return ['data' => self::withRoles([StrapiGraphql::dispatch($users, 'create', [], $request, $args['data'])])[0]];
            case 'update':
                return ['data' => self::withRoles([StrapiGraphql::dispatch($users, 'update', [], $request, $args['data'], [(string) $args['id']])])[0]];
            default:
                $deleted = StrapiGraphql::dispatch($users, 'destroy', [], $request, null, [(string) $args['id']]);

                return ['data' => $deleted === null ? null : $deleted + ['role' => null]];
        }
    }

    /** Roles are the project's own, so no role grants a read of them, nor any change: a token reads them. */
    private static function roles(string $verb, array $args, Request $request, ResolveInfo $info): mixed
    {
        if (! in_array($verb, ['find', 'findOne', 'connection'], true)) {
            throw new AuthorizationException();
        }
        self::readRoles($request, self::ROLE.($verb === 'findOne' ? '.findOne' : '.find'));
        $roles = Role::query()->orderBy('id')->get()->map(self::role(...))->all();
        if ($verb === 'findOne') {
            return array_values(array_filter($roles, fn (array $role) => $role['documentId'] === (string) $args['documentId']))[0] ?? null;
        }

        return self::listed($verb, self::matching($roles, self::query($args, $info)), $args);
    }

    private static function readRoles(Request $request, string $action): void
    {
        if (! StrapiGraphql::token()) {
            throw new AuthorizationException();
        }
        StrapiGraphql::authorize($request, $action);
    }

    /** users-permissions' me and changePassword need a session; a token is checked against them instead. */
    private static function signedInOrToken(Request $request): void
    {
        if ($request->user() === null && ! StrapiGraphql::token()) {
            throw new AuthorizationException();
        }
    }

    /** Each user's role as users-permissions shows it, read in one query. */
    private static function withRoles(array $rows): array
    {
        $ids = array_column($rows, 'id');
        $users = User::query()->with('roles')->whereIn('id', $ids)->get()->keyBy('id');

        return array_map(function (array $row) use ($users) {
            $role = $users->get($row['id'] ?? null)?->roles->first();

            return $row + ['role' => $role === null ? null : self::role($role)];
        }, $rows);
    }

    private static function role(Role $role): array
    {
        $shown = StrapiGraphqlTypes::ROLES[$role->name] ?? ['name' => ucfirst($role->name), 'description' => null];
        $at = fn ($time) => $time?->toIso8601ZuluString('millisecond');

        return [
            'id' => $role->getKey(),
            // The role's type names it for good; Strapi's documentId is a random one.
            'documentId' => $role->name,
            'name' => $shown['name'],
            'description' => $shown['description'],
            'type' => $role->name,
            'createdAt' => $at($role->created_at),
            'updatedAt' => $at($role->updated_at),
            'publishedAt' => $at($role->created_at),
        ];
    }

    private static function session(mixed $body): array
    {
        return ['jwt' => $body['jwt'] ?? null, 'user' => $body['user'] ?? null];
    }

    /** The REST auth routes' throttle, which an in-process call does not pass through. */
    private static function throttle(Request $request): void
    {
        $key = 'camis-graphql-auth|'.$request->ip();
        if (RateLimiter::tooManyAttempts($key, (int) config('camis.auth_throttle_per_minute', 10))) {
            throw new StrapiError(429, 'RateLimitError', 'Too many requests, please try again later.');
        }
        RateLimiter::hit($key, 60);
    }

    // ------------------------------------------------------------------------------- i18n, upload

    private static function locales(string $verb, array $args, Request $request, ResolveInfo $info): mixed
    {
        // Strapi checks the connection against plugin::i18n.locale.find, which no role is granted.
        $connection = $verb === 'connection';
        if ($connection && ! StrapiGraphql::token()) {
            throw new AuthorizationException();
        }
        $locales = StrapiGraphql::dispatch(LocaleController::class, 'index', [], $request, null, [], $connection ? 'plugin::i18n.locale.find' : null) ?? [];
        if ($verb === 'findOne') {
            return array_values(array_filter($locales, fn (array $locale) => $locale['documentId'] === (string) $args['documentId']))[0] ?? null;
        }

        return self::listed($verb, self::matching($locales, self::query($args, $info)), $args);
    }

    private static function files(string $verb, array $args, Request $request, ResolveInfo $info): mixed
    {
        $upload = UploadController::class;
        switch ($verb) {
            case 'find':
            case 'connection':
                return self::listed($verb, StrapiGraphql::dispatch($upload, 'find', self::query($args, $info), $request) ?? [], $args);
            case 'findOne':
                return (StrapiGraphql::dispatch($upload, 'find', self::byDocumentId($args), $request, null, [], 'plugin::upload.content-api.findOne') ?? [])[0] ?? null;
            case 'update':
                return StrapiGraphql::dispatch($upload, 'upload', ['id' => (string) $args['id']], $request, ['fileInfo' => $args['info'] ?? []]);
            default:
                return StrapiGraphql::found(fn () => StrapiGraphql::dispatch($upload, 'destroy', [], $request, null, [(string) $args['id']]));
        }
    }

    // ------------------------------------------------------------------------------------ lists

    /** A list field's filters and sort as REST takes them; the list is paged here. */
    private static function query(array $args, ResolveInfo $info): array
    {
        $params = StrapiGraphql::listing($args, $info->fieldDefinition->getArg('filters')?->getType());
        unset($params['pagination']);

        return $params;
    }

    private static function byDocumentId(array $args): array
    {
        return ['filters' => ['documentId' => ['$eq' => (string) $args['documentId']]]];
    }

    /** A list's page, and for a connection its pageInfo over the whole list. */
    private static function listed(string $verb, array $rows, array $args): array
    {
        $pagination = (array) ($args['pagination'] ?? []);
        $items = StrapiGraphql::page($rows, $pagination);
        if ($verb !== 'connection') {
            return $items;
        }
        $total = count($rows);
        $default = (int) config('camis.graphql.default_limit', 10);
        if (isset($pagination['start']) || isset($pagination['limit'])) {
            $meta = ['start' => (int) ($pagination['start'] ?? 0), 'limit' => (int) ($pagination['limit'] ?? $default), 'total' => $total];
        } else {
            $size = max(1, (int) ($pagination['pageSize'] ?? $default));
            $meta = ['page' => max(1, (int) ($pagination['page'] ?? 1)), 'pageSize' => $size, 'pageCount' => (int) ceil($total / $size), 'total' => $total];
        }

        return ['nodes' => $items, 'pageInfo' => StrapiGraphql::pageInfo($meta)];
    }

    /** Rows already read, filtered and sorted as Strapi's query engine would. */
    private static function matching(array $rows, array $params): array
    {
        $filters = $params['filters'] ?? [];
        $rows = array_values(array_filter($rows, fn (array $row) => self::matches($row, $filters)));
        $sort = $params['sort'] ?? [];
        $keys = array_map(fn (string $s) => array_pad(explode(':', $s, 2), 2, 'asc'), is_array($sort) ? $sort : explode(',', (string) $sort));
        usort($rows, function (array $a, array $b) use ($keys) {
            foreach ($keys as [$key, $direction]) {
                $order = ($a[$key] ?? null) <=> ($b[$key] ?? null);
                if ($order !== 0) {
                    return strtolower($direction) === 'desc' ? -$order : $order;
                }
            }

            return 0;
        });

        return $rows;
    }

    private static function matches(array $row, array $filters): bool
    {
        foreach ($filters as $key => $condition) {
            $ok = match ((string) $key) {
                '$and' => array_reduce((array) $condition, fn (bool $all, mixed $c) => $all && self::matches($row, (array) $c), true),
                '$or' => array_reduce((array) $condition, fn (bool $any, mixed $c) => $any || self::matches($row, (array) $c), false),
                '$not' => ! self::matches($row, (array) $condition),
                default => self::satisfies($row, (string) $key, $condition),
            };
            if (! $ok) {
                return false;
            }
        }

        return true;
    }

    private static function satisfies(array $row, string $key, mixed $condition): bool
    {
        if (! array_key_exists($key, $row) || is_array($row[$key])) {
            throw StrapiError::validation("Invalid key {$key}");
        }
        foreach (is_array($condition) ? $condition : ['$eq' => $condition] as $operator => $operand) {
            if (! self::compare($row[$key], (string) $operator, $operand)) {
                return false;
            }
        }

        return true;
    }

    private static function compare(mixed $value, string $operator, mixed $operand): bool
    {
        $lower = fn (mixed $v): string => mb_strtolower((string) $v);
        $text = (string) $value;

        return match ($operator) {
            '$eq' => $value !== null && $text === (string) $operand,
            '$eqi' => $value !== null && $lower($value) === $lower($operand),
            '$ne' => $value === null || $text !== (string) $operand,
            '$nei' => $value === null || $lower($value) !== $lower($operand),
            '$in' => $value !== null && in_array($text, array_map('strval', (array) $operand), true),
            '$notIn' => $value === null || ! in_array($text, array_map('strval', (array) $operand), true),
            '$contains' => $value !== null && str_contains($text, (string) $operand),
            '$notContains' => $value === null || ! str_contains($text, (string) $operand),
            '$containsi' => $value !== null && str_contains($lower($value), $lower($operand)),
            '$notContainsi' => $value === null || ! str_contains($lower($value), $lower($operand)),
            '$startsWith' => $value !== null && str_starts_with($text, (string) $operand),
            '$endsWith' => $value !== null && str_ends_with($text, (string) $operand),
            '$lt' => $value !== null && $value < $operand,
            '$lte' => $value !== null && $value <= $operand,
            '$gt' => $value !== null && $value > $operand,
            '$gte' => $value !== null && $value >= $operand,
            '$between' => $value !== null && is_array($operand) && count($operand) === 2 && $value >= $operand[0] && $value <= $operand[1],
            '$null' => ($value === null) === (bool) $operand,
            '$notNull' => ($value !== null) === (bool) $operand,
            '$not' => ! self::satisfies(['value' => $value], 'value', $operand),
            default => throw StrapiError::validation("Invalid operator {$operator}"),
        };
    }
}
`;
