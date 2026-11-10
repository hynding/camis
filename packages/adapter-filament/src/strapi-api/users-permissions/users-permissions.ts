import { PHP_MARKER } from "../../hooks/names";
import { sessionsConfigKeys } from "./sessions";
import { runtimePhp } from "../../runtime-php";

/**
 * Strapi's users-permissions plugin on the Laravel users table: the user wire shape, the advanced
 * and email settings, the account emails, the /users routes and the check that a blocked or
 * unconfirmed session is refused. The auth routes themselves are AuthController's (auth.ts).
 */

export const USERS_PERMISSIONS_MIGRATION_PATH =
  "database/migrations/0001_01_02_000001_add_users_permissions_to_users_table.php";
export const SETTINGS_MIGRATION_PATH =
  "database/migrations/0001_01_02_000002_create_strapi_settings_table.php";

/** The columns Strapi's up_users has and Laravel's users lacks. */
export const emitUsersPermissionsMigration = (): string =>
  runtimePhp(
    new URL(
      "./php/database/migrations/0001_01_02_000001_add_users_permissions_to_users_table.php",
      import.meta.url,
    ),
  );

export const emitSettingsMigration = (): string =>
  runtimePhp(
    new URL(
      "./php/database/migrations/0001_01_02_000002_create_strapi_settings_table.php",
      import.meta.url,
    ),
  );

/** Strapi's plugin store: settings an administrator edits at runtime, over config's defaults. */
export const emitStrapiSettings = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiSettings.php", import.meta.url));

/** The users-permissions defaults a new Strapi project starts with, as config/camis.php keys. */
export const usersPermissionsConfigKeys = (): string => `

    // Strapi's users-permissions settings as a new project starts with them; the admin's
    // Users & Permissions settings page overrides them at runtime (strapi_settings).
    'users_permissions' => [${sessionsConfigKeys()}
        // users-permissions' register.allowedFields: body keys register takes beside username,
        // email and password (comma separated). A key the user has no column for is accepted and
        // dropped, as Strapi drops it.
        'register' => [
            'allowed_fields' => array_values(array_filter(array_map('trim', explode(',', (string) env('CAMIS_REGISTER_ALLOWED_FIELDS', ''))))),
        ],
        'advanced' => [
            'unique_email' => true,
            'allow_register' => (bool) env('CAMIS_ALLOW_REGISTER', true),
            'email_confirmation' => (bool) env('CAMIS_EMAIL_CONFIRMATION', false),
            'email_reset_password' => env('CAMIS_EMAIL_RESET_PASSWORD_URL'),
            'email_confirmation_redirection' => env('CAMIS_EMAIL_CONFIRMATION_REDIRECTION'),
        ],
        // A sender left empty is Laravel's mail.from.
        'email' => [
            'reset_password' => [
                'from' => ['name' => null, 'email' => null],
                'response_email' => '',
                'object' => 'Reset password',
                'message' => "<p>We heard that you lost your password. Sorry about that!</p>\\n\\n<p>But don’t worry! You can use the following link to reset your password:</p>\\n<p><%= URL %>?code=<%= TOKEN %></p>\\n\\n<p>Thanks.</p>",
            ],
            'email_confirmation' => [
                'from' => ['name' => null, 'email' => null],
                'response_email' => '',
                'object' => 'Account confirmation',
                'message' => "<p>Thank you for registering!</p>\\n\\n<p>You have to confirm your email address. Please click on the link below.</p>\\n\\n<p><%= URL %>?confirmation=<%= CODE %></p>\\n\\n<p>Thanks.</p>",
            ],
        ],
    ],`;

/**
 * The user as Strapi's users-permissions sanitizes it, the settings, the account emails and
 * Strapi's yup validation messages for the auth and user bodies.
 */
export const emitStrapiUsers = (): string =>
  runtimePhp(new URL("./php/app/Support/StrapiUsers.php", import.meta.url));

/**
 * How a route takes credentials beyond Laravel's own guard. `optional`: a request may come without
 * a session (it then acts as the public role), but a token that does not verify is refused, as
 * Strapi refuses it on every route. `guest`: a route Strapi grants to its public role alone
 * (logging in, registering, recovering a password), which a session is forbidden. `required`
 * (with API tokens, in place of `auth:sanctum`): a session or an API token, which StrapiApiToken
 * has already checked against the route and which acts for no account.
 */
/**
 * The user as a relation target: populate, filters and sort reach it through these maps, and it
 * renders as users-permissions' user. Its role is a relation as on Strapi, which only an API token
 * holding the role's find reaches (no content grant does), so for anyone else populate leaves it
 * out and a filter on it is an invalid key; a project without roles keeps none. Spatie keeps a
 * user's roles as a morph-to-many, but Strapi's user holds one role, so it renders as one.
 */
export const emitUserSerializer = (secured: boolean): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Serializers;

use App\\Models\\User;
use App\\Support\\StrapiUsers;

final class UserSerializer
{
    /** Wire path → column, for StrapiQuery's filters, sort and fields. */
    public const FIELDS = StrapiUsers::FIELDS + [${
      secured
        ? `
        'role' => ['relation' => 'roles', 'kind' => 'morphToOne', 'model' => \\Spatie\\Permission\\Models\\Role::class, 'serializer' => \\App\\Http\\Serializers\\RoleSerializer::class, 'foreignKey' => null, 'uid' => 'plugin::users-permissions.role', 'holder' => 'self', 'draftPublish' => false, 'localized' => false],
    `
        : ""
    }];

    public const COMPONENTS = [];

    public const ZONES = [];

    public const DRAFT_PUBLISH = false;

    public const LOCALIZED = false;

    public static function toWire(User $m): array
    {
        return StrapiUsers::wire($m);
    }
}
`;

/**
 * users-permissions' role as a relation target (the user's role, populated for an API token that
 * may read roles). Spatie's roles keep only the type: Strapi's name and description come from it
 * and the IR, so a filter or sort on either reads the type.
 */
export const emitRoleSerializer = (): string =>
  runtimePhp(new URL("./php/app/Http/Serializers/RoleSerializer.php", import.meta.url));

export const emitStrapiCredentials = (tokens = false): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Middleware;
${tokens ? "\nuse App\\Support\\StrapiApiTokens;" : ""}
use App\\Support\\StrapiError;
use Closure;${tokens ? "\nuse Illuminate\\Auth\\AuthenticationException;" : ""}
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Auth;
use Symfony\\Component\\HttpFoundation\\Response;

final class StrapiCredentials
{
    public function handle(Request $request, Closure $next, string $mode): Response
    {
${
  tokens
    ? `        if (StrapiApiTokens::active() || ($request->bearerToken() === null && $mode !== 'required')) {
            return $next($request);
        }
        if ($request->bearerToken() === null) {
            throw new AuthenticationException();
        }`
    : `        if ($request->bearerToken() === null) {
            return $next($request);
        }`
}
        if (Auth::guard('sanctum')->user() === null) {
            throw new StrapiError(401, 'UnauthorizedError', 'Missing or invalid credentials');
        }
        if ($mode === 'guest') {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }
        Auth::shouldUse('sanctum');

        return $next($request);
    }
}
`;

/** users-permissions' strategy refuses a session whose user was blocked or is unconfirmed. */
export const emitStrapiActiveUser = (): string =>
  runtimePhp(new URL("./php/app/Http/Middleware/StrapiActiveUser.php", import.meta.url));

/**
 * users-permissions' /users routes: the list, count and read are the builtin user's read grant,
 * and its writes its create, update and delete grants. /users/me is every session's.
 */
/** `guests`: the list is served without a session too, on the public role's user grants. */
export const emitUserController = (secured: boolean, guests = false): string => {
  const allow = (permission: string): string =>
    secured ? `\n        $this->allow($request, '${permission}');` : "";
  const roleRule = secured ? ", 'role' => ['required']" : "";
  const assignRole = secured
    ? `
        $role = Role::query()->find($body['role']);
        if ($role === null) {
            throw StrapiUsers::application('1 relation(s) of type plugin::users-permissions.role associated with this entity do not exist');
        }
`
    : "";
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Http\\Serializers\\UserSerializer;
use App\\Models\\User;${guests ? "\nuse App\\Support\\PublicRole;" : ""}${secured ? "\nuse App\\Support\\StrapiApiTokens;" : ""}
use App\\Support\\StrapiError;
use App\\Support\\StrapiPopulate;
use App\\Support\\StrapiQuery;
use App\\Support\\StrapiUsers;
use Illuminate\\Database\\Eloquent\\Builder;
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\Request;
use Illuminate\\Http\\Response;
use Illuminate\\Support\\Facades\\Hash;${secured ? "\nuse Spatie\\Permission\\Models\\Role;" : ""}

/** Strapi users-permissions' user controller over the Laravel users table. */
final class UserController extends Controller
{
    public function find(Request $request): JsonResponse
    {${allow("user.read")}
        $params = $request->query();
        $query = $this->filtered($request);
        StrapiUsers::paginate($query, $params);

        return response()->json(StrapiPopulate::many($query->get(), $params, UserSerializer::class, $request->user()));
    }

    /**
     * Strapi answers a user it cannot find with an empty body, not a 404. Its fetch keeps the
     * query's start, so any start past 0 finds nothing.
     */
    public function findOne(Request $request, string $id): JsonResponse|Response
    {${allow("user.read")}
        $params = $request->query();
        $query = User::query()->whereKey($id);
        StrapiUsers::paginate($query, $params);
        $user = $query->first();

        return $user === null
            ? response()->noContent()
            : response()->json(StrapiPopulate::one($user, $params, UserSerializer::class, $request->user()));
    }

    /** Strapi checks start and limit on a count too, though it counts every match. */
    public function count(Request $request): JsonResponse
    {${allow("user.read")}
        $query = $this->filtered($request);
        StrapiUsers::paginate($query->clone(), $request->query());

        return response()->json($query->count());
    }

    /** An API token's request reaches here with no account of its own. */
    public function me(Request $request): JsonResponse
    {
        $user = $request->user() ?? throw new StrapiError(401, 'UnauthorizedError', 'Unauthorized');

        return response()->json(StrapiPopulate::one($user, $request->query(), UserSerializer::class, $user));
    }

    public function create(Request $request): JsonResponse
    {${allow("user.create")}
        $body = $request->json()->all();
        StrapiUsers::validate($body, ['email' => ['required', 'email'], 'username' => ['required'], 'password' => ['required']${roleRule}]);
        if ((bool) (StrapiUsers::advanced()['unique_email'] ?? false) && User::query()->where('email', mb_strtolower((string) $body['email']))->exists()) {
            throw StrapiUsers::application('Email already taken');
        }
        // users-permissions' entity validator: the username attribute is unique.
        if (User::query()->where('username', $body['username'])->exists()) {
            throw StrapiUsers::application('This attribute must be unique');
        }
${assignRole}        $user = StrapiUsers::add([...$body, 'password' => Hash::make((string) $body['password'])]);${secured ? "\n        $user->assignRole($role);" : ""}

        return response()->json(StrapiUsers::wire($user), 201);
    }

    public function update(Request $request, string $id): JsonResponse
    {${allow("user.update")}
        $user = User::query()->find($id) ?? throw new StrapiError(404, 'NotFoundError', 'User not found');
        $body = $request->json()->all();
        StrapiUsers::validate($body, ['email' => ['email', 'nonEmpty'], 'username' => ['nonEmpty']]);
        if (($user->provider ?? 'local') === 'local' && array_key_exists('password', $body) && in_array($body['password'], [null, '', false, 0], true)) {
            throw StrapiError::validation('password.notNull');
        }
        if (array_key_exists('username', $body) && User::query()->where('username', $body['username'])->whereKeyNot($user->getKey())->exists()) {
            throw StrapiUsers::application('Username already taken');
        }
        if (array_key_exists('email', $body)) {
            $body['email'] = mb_strtolower((string) $body['email']);
            if ((bool) (StrapiUsers::advanced()['unique_email'] ?? false) && User::query()->where('email', $body['email'])->whereKeyNot($user->getKey())->exists()) {
                throw StrapiUsers::application('Email already taken');
            }
        }
        $changes = array_intersect_key($body, array_flip(['username', 'email', 'confirmed', 'blocked']));
        if (isset($body['password'])) {
            $changes['password'] = Hash::make((string) $body['password']);
        }
        $user->forceFill($changes)->save();

        return response()->json(StrapiUsers::wire($user));
    }

    public function destroy(Request $request, string $id): JsonResponse|Response
    {${allow("user.delete")}
        $user = User::query()->find($id);
        if ($user === null) {
            return response()->noContent();
        }
        $wire = StrapiUsers::wire($user);
        $user->delete();

        return response()->json($wire);
    }

    private function filtered(Request $request): Builder
    {
        $params = $request->query();
        $query = User::query();
        StrapiQuery::filter($query, $params, UserSerializer::FIELDS, $request->user(), null);
        StrapiQuery::order($query, $params['sort'] ?? null, UserSerializer::FIELDS, $request->user());

        return $query;
    }${
      secured
        ? `

    private function allow(Request $request, string $permission): void
    {
        // An API token's request was already checked against its token, which stands in for a role.
        if (StrapiApiTokens::active()) {
            return;
        }
        if (! ${guests ? "PublicRole::allows($request->user(), $permission)" : "$request->user()->can($permission)"}) {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }
    }`
        : ""
    }
}
`;
};
