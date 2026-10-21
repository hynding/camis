import { PHP_MARKER } from "../hooks/names";
import { sessionsConfigKeys } from "./sessions";

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
export const emitUsersPermissionsMigration = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\DB;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->string('document_id', 24)->nullable()->unique();
            $table->string('provider')->default('local');
            $table->string('reset_password_token')->nullable()->index();
            $table->string('confirmation_token')->nullable()->index();
            $table->boolean('confirmed')->default(false);
            $table->boolean('blocked')->default(false);
        });
        // Accounts made before the plugin could sign in; they stay able to when confirmation is on.
        DB::table('users')->update(['confirmed' => true]);
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->dropUnique(['document_id']);
            $table->dropIndex(['reset_password_token']);
            $table->dropIndex(['confirmation_token']);
            $table->dropColumn(['document_id', 'provider', 'reset_password_token', 'confirmation_token', 'confirmed', 'blocked']);
        });
    }
};
`;

export const emitSettingsMigration = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('strapi_settings', function (Blueprint $table): void {
            $table->string('key')->primary();
            $table->json('value');
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('strapi_settings');
    }
};
`;

/** Strapi's plugin store: settings an administrator edits at runtime, over config's defaults. */
export const emitStrapiSettings = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

use Illuminate\\Support\\Facades\\DB;

final class StrapiSettings
{
    public static function get(string $key, array $defaults = []): array
    {
        $stored = DB::table('strapi_settings')->where('key', $key)->value('value');

        return array_replace_recursive($defaults, is_string($stored) ? (array) json_decode($stored, true) : []);
    }

    public static function merge(string $key, array $values): void
    {
        $now = now();
        DB::table('strapi_settings')->upsert(
            [['key' => $key, 'value' => json_encode(array_replace(self::get($key), $values)), 'created_at' => $now, 'updated_at' => $now]],
            ['key'],
            ['value', 'updated_at'],
        );
    }
}
`;

/** The users-permissions defaults a new Strapi project starts with, as config/camis.php keys. */
export const usersPermissionsConfigKeys = (): string => `

    // Strapi's users-permissions settings as a new project starts with them; the admin's
    // Users & Permissions settings page overrides them at runtime (strapi_settings).
    'users_permissions' => [${sessionsConfigKeys()}
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
export const emitStrapiUsers = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Support;

use App\\Models\\Concerns\\HasDocumentId;
use App\\Models\\User;
use Illuminate\\Mail\\Message;
use Illuminate\\Support\\Facades\\Mail;

final class StrapiUsers
{
    public const FIELDS = [
        'id' => ['column' => 'id', 'type' => 'integer'],
        'documentId' => ['column' => 'document_id', 'type' => 'string'],
        'username' => ['column' => 'username', 'type' => 'string'],
        'email' => ['column' => 'email', 'type' => 'email'],
        'provider' => ['column' => 'provider', 'type' => 'string'],
        'confirmed' => ['column' => 'confirmed', 'type' => 'boolean'],
        'blocked' => ['column' => 'blocked', 'type' => 'boolean'],
        'createdAt' => ['column' => 'created_at', 'type' => 'dateTime'],
        'updatedAt' => ['column' => 'updated_at', 'type' => 'dateTime'],
        // A user is published when it is made; Laravel's users table keeps no separate column.
        'publishedAt' => ['column' => 'created_at', 'type' => 'dateTime'],
    ];

    public static function wire(User $user): array
    {
        if (($user->document_id ?? '') === '') {
            $user->forceFill(['document_id' => self::newDocumentId()])->saveQuietly();
        }

        return [
            'id' => $user->id,
            'documentId' => $user->document_id,
            'username' => $user->username,
            'email' => $user->email,
            'provider' => $user->provider ?? 'local',
            'confirmed' => (bool) $user->confirmed,
            'blocked' => (bool) $user->blocked,
            'createdAt' => $user->created_at?->toIso8601ZuluString('millisecond'),
            'updatedAt' => $user->updated_at?->toIso8601ZuluString('millisecond'),
            'publishedAt' => $user->created_at?->toIso8601ZuluString('millisecond'),
        ];
    }

    /** A new account (local unless a provider made it), as users-permissions' user service adds one. */
    public static function add(array $values): User
    {
        $user = new User();
        $user->forceFill([
            'name' => $values['username'],
            'username' => $values['username'],
            'email' => mb_strtolower((string) $values['email']),
            'password' => $values['password'],
            'provider' => $values['provider'] ?? 'local',
            'confirmed' => (bool) ($values['confirmed'] ?? false),
            'blocked' => (bool) ($values['blocked'] ?? false),
            'document_id' => self::newDocumentId(),
        ])->save();

        return $user;
    }

    public static function advanced(): array
    {
        return StrapiSettings::get('users-permissions.advanced', (array) config('camis.users_permissions.advanced', []));
    }

    public static function emails(): array
    {
        return StrapiSettings::get('users-permissions.email', (array) config('camis.users_permissions.email', []));
    }

    public static function sendResetPassword(User $user, string $token): void
    {
        self::send($user, self::emails()['reset_password'] ?? [], [
            'URL' => self::advanced()['email_reset_password'] ?? null,
            'SERVER_URL' => url('/'),
            'USER' => self::wire($user),
            'TOKEN' => $token,
        ]);
    }

    public static function sendConfirmation(User $user): void
    {
        $token = bin2hex(random_bytes(20));
        $user->forceFill(['confirmation_token' => $token])->save();
        self::send($user, self::emails()['email_confirmation'] ?? [], [
            'URL' => url('/api/auth/email-confirmation'),
            'SERVER_URL' => url('/'),
            'USER' => self::wire($user),
            'CODE' => $token,
        ]);
    }

    /**
     * Strapi's yup validation of a request body, with its messages: each rule is a field's list of
     * checks (required, email, nonEmpty, maxPassword, or same:<field>).
     *
     * @param array<string, list<string>> $rules
     */
    public static function validate(array $body, array $rules): void
    {
        $errors = [];
        foreach ($rules as $field => $checks) {
            $message = self::check($body, $field, $checks);
            if ($message === null) {
                continue;
            }
            $error = ['path' => [$field], 'message' => $message, 'name' => 'ValidationError'];
            if (array_key_exists($field, $body)) {
                $error['value'] = $body[$field];
            }
            $errors[] = $error;
        }
        if ($errors !== []) {
            $message = count($errors) > 1 ? count($errors).' errors occurred' : $errors[0]['message'];

            throw StrapiError::validation($message, ['errors' => $errors]);
        }
    }

    public static function application(string $message): StrapiError
    {
        return new StrapiError(400, 'ApplicationError', $message);
    }

    private static function check(array $body, string $field, array $checks): ?string
    {
        $value = $body[$field] ?? null;
        $present = $value !== null && $value !== '';
        foreach ($checks as $check) {
            $failed = match (true) {
                $check === 'required' => ! $present,
                $check === 'email' => $present && filter_var($value, FILTER_VALIDATE_EMAIL) === false,
                $check === 'nonEmpty' => array_key_exists($field, $body) && (! is_scalar($value) || (string) $value === ''),
                $check === 'maxPassword' => is_string($value) && strlen($value) > 72,
                str_starts_with($check, 'same:') => $present && $value !== ($body[substr($check, 5)] ?? null),
                default => false,
            };
            if ($failed) {
                return match (true) {
                    $check === 'required' => "{$field} is a required field",
                    $check === 'email' => "{$field} must be a valid email",
                    $check === 'nonEmpty' => "{$field} must be at least 1 characters",
                    $check === 'maxPassword' => 'Password must be less than 73 bytes',
                    default => 'Passwords do not match',
                };
            }
        }

        return null;
    }

    private static function send(User $user, array $template, array $variables): void
    {
        $html = self::template((string) ($template['message'] ?? ''), $variables);
        $subject = self::template((string) ($template['object'] ?? ''), ['USER' => $variables['USER']]);
        $from = (array) ($template['from'] ?? []);
        Mail::html($html, function (Message $message) use ($user, $subject, $from, $template): void {
            $message->to($user->email)->subject($subject);
            if (($from['email'] ?? '') !== '') {
                $message->from($from['email'], ($from['name'] ?? '') !== '' ? $from['name'] : null);
            }
            if (($template['response_email'] ?? '') !== '') {
                $message->replyTo($template['response_email']);
            }
        });
    }

    /** Strapi's lodash template interpolation: <%= NAME %> and <%= USER.username %>. */
    private static function template(string $layout, array $variables): string
    {
        return (string) preg_replace_callback('/<%=\\s*([A-Za-z_][\\w.]*)\\s*%>/', function (array $match) use ($variables): string {
            $value = $variables;
            foreach (explode('.', $match[1]) as $key) {
                $value = is_array($value) ? ($value[$key] ?? '') : '';
            }

            return is_scalar($value) ? (string) $value : '';
        }, $layout);
    }

    private static function newDocumentId(): string
    {
        return (new class () {
            use HasDocumentId;
        })::newDocumentId();
    }
}
`;

/**
 * How a route takes credentials beyond Laravel's own guard. `optional`: a request may come without
 * a session (it then acts as the public role), but a token that does not verify is refused, as
 * Strapi refuses it on every route. `guest`: a route Strapi grants to its public role alone
 * (logging in, registering, recovering a password), which a session is forbidden. `required`
 * (with API tokens, in place of `auth:sanctum`): a session or an API token, which StrapiApiToken
 * has already checked against the route and which acts for no account.
 */
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
export const emitStrapiActiveUser = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Middleware;

use App\\Support\\StrapiError;
use App\\Support\\StrapiUsers;
use Closure;
use Illuminate\\Http\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

final class StrapiActiveUser
{
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();
        if ($user !== null && ((bool) $user->blocked || (! (bool) $user->confirmed && (bool) (StrapiUsers::advanced()['email_confirmation'] ?? false)))) {
            throw new StrapiError(401, 'UnauthorizedError', 'Invalid credentials');
        }

        return $next($request);
    }
}
`;

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
use App\\Models\\User;${guests ? "\nuse App\\Support\\PublicRole;" : ""}${secured ? "\nuse App\\Support\\StrapiApiTokens;" : ""}
use App\\Support\\StrapiError;
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

        return response()->json($this->filtered($request)->get()
            ->map(fn (User $user) => StrapiQuery::select(StrapiUsers::wire($user), $params, StrapiUsers::FIELDS))
            ->values()
            ->all());
    }

    /** Strapi answers a user it cannot find with an empty body, not a 404. */
    public function findOne(Request $request, string $id): JsonResponse|Response
    {${allow("user.read")}
        $user = User::query()->find($id);

        return $user === null ? response()->noContent() : response()->json(StrapiUsers::wire($user));
    }

    public function count(Request $request): JsonResponse
    {${allow("user.read")}

        return response()->json($this->filtered($request)->count());
    }

    /** An API token's request reaches here with no account of its own. */
    public function me(Request $request): JsonResponse
    {
        $user = $request->user() ?? throw new StrapiError(401, 'UnauthorizedError', 'Unauthorized');

        return response()->json(StrapiUsers::wire($user));
    }

    public function create(Request $request): JsonResponse
    {${allow("user.create")}
        $body = $request->json()->all();
        StrapiUsers::validate($body, ['email' => ['required', 'email'], 'username' => ['required'], 'password' => ['required']${roleRule}]);
        if ((bool) (StrapiUsers::advanced()['unique_email'] ?? false) && User::query()->where('email', mb_strtolower((string) $body['email']))->exists()) {
            throw StrapiUsers::application('Email already taken');
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
        StrapiQuery::filter($query, $params, StrapiUsers::FIELDS, $request->user(), null);
        StrapiQuery::order($query, $params['sort'] ?? null, StrapiUsers::FIELDS, $request->user());

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
