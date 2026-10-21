import { PHP_MARKER } from "../hooks/names";

/**
 * Strapi users-permissions' sessions (`jwtManagement: 'refresh'`, opt-in as in Strapi): each login
 * opens a session whose refresh token rotates on use, and whose access token is a Sanctum token
 * that expires within minutes. `legacy-support`, Strapi's default, keeps one token per login.
 */

export const SESSIONS_MIGRATION_PATH =
  "database/migrations/0001_01_02_000003_create_strapi_sessions_table.php";

/** Strapi's session settings and their defaults (users-permissions' constants). */
export const sessionsConfigKeys = (): string => `
        // Strapi's jwtManagement: 'legacy-support' issues one lasting token per login, 'refresh'
        // a short access token with a rotating refresh token, and lists the account's sessions.
        'jwt_management' => env('CAMIS_JWT_MANAGEMENT', 'legacy-support'),
        'sessions' => [
            'access_token_lifespan' => (int) env('CAMIS_ACCESS_TOKEN_LIFESPAN', 600),
            'max_refresh_token_lifespan' => (int) env('CAMIS_MAX_REFRESH_TOKEN_LIFESPAN', 2592000),
            'idle_refresh_token_lifespan' => (int) env('CAMIS_IDLE_REFRESH_TOKEN_LIFESPAN', 1209600),
            // The refresh token in an httpOnly cookie rather than the body (also per request,
            // with the x-strapi-refresh-cookie: httpOnly header). Secure unset is production only.
            'http_only' => (bool) env('CAMIS_SESSIONS_HTTP_ONLY', false),
            'cookie' => [
                'name' => env('CAMIS_SESSIONS_COOKIE_NAME', 'strapi_up_refresh'),
                'secure' => env('CAMIS_SESSIONS_COOKIE_SECURE'),
                'same_site' => env('CAMIS_SESSIONS_COOKIE_SAME_SITE', 'lax'),
                'path' => env('CAMIS_SESSIONS_COOKIE_PATH', '/'),
                'domain' => env('CAMIS_SESSIONS_COOKIE_DOMAIN'),
            ],
        ],`;

export const emitSessionsMigration = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('strapi_sessions', function (Blueprint $table): void {
            $table->id();
            $table->string('session_id', 32)->unique();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('device_id')->nullable();
            $table->string('status', 16);
            $table->string('child_id', 32)->nullable();
            $table->json('metadata')->nullable();
            $table->string('token_hash', 64);
            $table->dateTime('expires_at', 3);
            $table->dateTime('absolute_expires_at', 3);
            $table->dateTime('created_at', 3);
            $table->index(['user_id', 'device_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('strapi_sessions');
    }
};
`;

export const emitStrapiSessions = (): string => String.raw`<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\Support;

use App\Models\User;
use Carbon\CarbonImmutable;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Laravel\Sanctum\Sanctum;
use Symfony\Component\HttpFoundation\Cookie;

/**
 * A session's refresh token is its id and a secret, of which only a hash is kept. Rotating it
 * opens a successor and moves the access tokens the session issued onto it, so ending a session
 * revokes them at once rather than at their expiry, as Strapi's stateless tokens would be.
 */
final class StrapiSessions
{
    private const TABLE = 'strapi_sessions';

    private const PREFIX = 'session:';

    // Strapi's user-agent heuristics in its order: the more specific tokens first.
    private const BROWSERS = [
        '~\bEdg(?:e|A|iOS)?/~' => 'Edge',
        '~\b(?:OPR|Opera)/~' => 'Opera',
        '~\bSamsungBrowser/~' => 'Samsung Internet',
        '~\bVivaldi/~' => 'Vivaldi',
        '~\b(?:YaBrowser|Yowser)/~' => 'Yandex Browser',
        '~\bBrave/~' => 'Brave',
        '~\b(?:Firefox|FxiOS)/~' => 'Firefox',
        '~\b(?:Chrome|CriOS|Chromium)/~' => 'Chrome',
        '~\bSafari/~' => 'Safari',
    ];

    private const SYSTEMS = [
        '~\bWindows NT\b~' => 'Windows',
        '~\b(?:iPhone|iPad|iPod)\b~' => 'iOS',
        '~\bAndroid\b~' => 'Android',
        '~\b(?:Macintosh|Mac OS X)\b~' => 'macOS',
        '~\bCrOS\b~' => 'ChromeOS',
        '~\bLinux\b~' => 'Linux',
    ];

    public static function refreshMode(): bool
    {
        return config('camis.users_permissions.jwt_management') === 'refresh';
    }

    /** A login's answer: the refresh token goes in the body, or in a cookie when one is asked for. */
    public static function login(Request $request, User $user): JsonResponse
    {
        $wire = ['user' => StrapiUsers::wire($user)];
        if (! self::refreshMode()) {
            return response()->json(['jwt' => self::lasting($user)] + $wire);
        }
        $deviceId = $request->json('deviceId');
        $tokens = self::open($user, is_string($deviceId) && $deviceId !== '' ? $deviceId : null, self::metadata($request));

        return self::respond($request, $tokens, $wire);
    }

    /** A registration's: a session on a device of its own, its tokens in the body. */
    public static function registered(Request $request, User $user): array
    {
        $wire = ['user' => StrapiUsers::wire($user)];
        if (! self::refreshMode()) {
            return ['jwt' => self::lasting($user)] + $wire;
        }

        return self::open($user, (string) Str::uuid(), self::metadata($request)) + $wire;
    }

    /** After a password change or reset every session ends, and one starts on a new device. */
    public static function reissue(User $user): array
    {
        $wire = ['user' => StrapiUsers::wire($user)];
        if (! self::refreshMode()) {
            return ['jwt' => self::lasting($user)] + $wire;
        }
        self::invalidate($user);

        return self::open($user, (string) Str::uuid(), null) + $wire;
    }

    /** The refresh token a request presents: its cookie first, then its body. */
    public static function presented(Request $request): ?string
    {
        $cookie = $request->cookie(self::cookieName());
        if (is_string($cookie) && $cookie !== '') {
            return $cookie;
        }
        $token = $request->json('refreshToken');

        return is_string($token) && $token !== '' ? $token : null;
    }

    /**
     * The successor of a refresh token and an access token for it, or null when the token may no
     * longer be used. The old session stays behind as rotated, so the token cannot be used twice.
     *
     * @return array{jwt: string, refreshToken: string}|null
     */
    public static function rotate(string $token): ?array
    {
        $current = self::usable($token);
        $user = $current === null ? null : User::query()->find($current->user_id);
        if ($current === null || $user === null) {
            return null;
        }
        $sessionId = bin2hex(random_bytes(16));
        $secret = bin2hex(random_bytes(32));
        $rotated = DB::transaction(function () use ($current, $sessionId, $secret): bool {
            $claimed = DB::table(self::TABLE)->where('session_id', $current->session_id)->where('status', 'active')
                ->update(['status' => 'rotated', 'child_id' => $sessionId]);
            if ($claimed !== 1) {
                return false;
            }
            self::insert($current->user_id, $sessionId, $secret, $current->device_id, $current->metadata, $current->absolute_expires_at);
            self::tokens([$current->session_id])->update(['name' => self::PREFIX.$sessionId]);

            return true;
        });

        return $rotated ? ['jwt' => self::accessToken($user, $sessionId), 'refreshToken' => $sessionId.'.'.$secret] : null;
    }

    /** The session a usable refresh token names. */
    public static function sessionOf(?string $token): ?string
    {
        return $token === null ? null : self::usable($token)?->session_id;
    }

    /** The session behind the request's access token. */
    public static function current(Request $request): ?string
    {
        $name = $request->user()?->currentAccessToken()?->name ?? null;

        return is_string($name) && str_starts_with($name, self::PREFIX) ? substr($name, strlen(self::PREFIX)) : null;
    }

    /** The account's sessions as Strapi lists them: the current one first, then the latest used. */
    public static function list(User $user, ?string $current): array
    {
        $sessions = DB::table(self::TABLE)->where('user_id', $user->getKey())->where('status', 'active')->orderBy('id')->get()
            ->map(fn (object $row): array => self::entry($row, $current))
            ->all();
        usort($sessions, fn (array $a, array $b): int => $a['current'] !== $b['current']
            ? ($a['current'] ? -1 : 1)
            : strcmp($b['lastActiveAt'], $a['lastActiveAt']));

        return $sessions;
    }

    public static function revoke(User $user, string $sessionId): bool
    {
        $session = DB::table(self::TABLE)->where('user_id', $user->getKey())->where('session_id', $sessionId);
        if (! $session->exists()) {
            return false;
        }
        self::end($session);

        return true;
    }

    /** Ends every session of $user, or every one on a device. */
    public static function invalidate(User $user, ?string $deviceId = null): void
    {
        self::end(DB::table(self::TABLE)->where('user_id', $user->getKey())
            ->when($deviceId !== null, fn (Builder $q) => $q->where('device_id', $deviceId)));
    }

    public static function cookieMode(Request $request): bool
    {
        return (bool) config('camis.users_permissions.sessions.http_only') || $request->header('x-strapi-refresh-cookie') === 'httpOnly';
    }

    public static function cookie(string $refreshToken): Cookie
    {
        $options = (array) config('camis.users_permissions.sessions.cookie', []);
        $secure = $options['secure'] ?? null;

        return cookie(
            self::cookieName(),
            $refreshToken,
            0,
            (string) ($options['path'] ?? '/'),
            $options['domain'] ?? null,
            $secure === null ? app()->isProduction() : (bool) $secure,
            true,
            true,
            (string) ($options['same_site'] ?? 'lax'),
        );
    }

    public static function forget(): Cookie
    {
        $options = (array) config('camis.users_permissions.sessions.cookie', []);

        return cookie()->forget(self::cookieName(), (string) ($options['path'] ?? '/'), $options['domain'] ?? null);
    }

    /** @param array{jwt: string, refreshToken: string} $tokens */
    public static function respond(Request $request, array $tokens, array $body = []): JsonResponse
    {
        if (! self::cookieMode($request)) {
            return response()->json($tokens + $body);
        }

        return response()->json(['jwt' => $tokens['jwt']] + $body)->withCookie(self::cookie($tokens['refreshToken']));
    }

    /** Strapi's legacy token, for as long as the user keeps it. */
    private static function lasting(User $user): string
    {
        return $user->createToken('api')->plainTextToken;
    }

    /** @return array{jwt: string, refreshToken: string} */
    private static function open(User $user, ?string $deviceId, ?array $metadata): array
    {
        self::sweep();
        $sessionId = bin2hex(random_bytes(16));
        $secret = bin2hex(random_bytes(32));
        $absolute = self::stamp(CarbonImmutable::now()->addSeconds(self::lifespan('max_refresh_token_lifespan')));
        self::insert($user->getKey(), $sessionId, $secret, $deviceId, $metadata === null ? null : json_encode($metadata), $absolute);

        return ['jwt' => self::accessToken($user, $sessionId), 'refreshToken' => $sessionId.'.'.$secret];
    }

    private static function insert(mixed $userId, string $sessionId, string $secret, ?string $deviceId, ?string $metadata, string $absolute): void
    {
        $now = CarbonImmutable::now();
        DB::table(self::TABLE)->insert([
            'session_id' => $sessionId,
            'user_id' => $userId,
            'device_id' => $deviceId,
            'status' => 'active',
            'child_id' => null,
            'metadata' => $metadata,
            'token_hash' => hash('sha256', $secret),
            'expires_at' => self::stamp($now->addSeconds(self::lifespan('idle_refresh_token_lifespan'))),
            'absolute_expires_at' => $absolute,
            'created_at' => self::stamp($now),
        ]);
    }

    private static function accessToken(User $user, string $sessionId): string
    {
        return $user->createToken(self::PREFIX.$sessionId, ['*'], now()->addSeconds(self::lifespan('access_token_lifespan')))->plainTextToken;
    }

    /** An active session inside its idle and absolute windows whose secret the token holds. */
    private static function usable(string $token): ?object
    {
        [$sessionId, $secret] = array_pad(explode('.', $token, 2), 2, '');
        $session = DB::table(self::TABLE)->where('session_id', $sessionId)->first();
        if ($session === null || $session->status !== 'active' || ! hash_equals($session->token_hash, hash('sha256', $secret))) {
            return null;
        }
        $now = CarbonImmutable::now();
        if (CarbonImmutable::parse($session->expires_at)->lte($now) || CarbonImmutable::parse($session->absolute_expires_at)->lte($now)) {
            return null;
        }

        return $session;
    }

    /** Ends sessions and the access tokens they issued. */
    private static function end(Builder $sessions): void
    {
        $ids = (clone $sessions)->pluck('session_id')->all();
        self::tokens($ids)->delete();
        $sessions->delete();
    }

    private static function tokens(array $sessionIds): \Illuminate\Database\Eloquent\Builder
    {
        return Sanctum::$personalAccessTokenModel::query()
            ->whereIn('name', array_map(fn (string $id): string => self::PREFIX.$id, $sessionIds));
    }

    /**
     * Without a scheduler to rely on, about one login in fifty clears the sessions and access
     * tokens that can no longer be used, as Strapi clears its sessions every fifty calls.
     */
    private static function sweep(): void
    {
        if (random_int(1, 50) !== 1) {
            return;
        }
        $now = self::stamp(CarbonImmutable::now());
        DB::table(self::TABLE)->where(fn (Builder $q) => $q->where('expires_at', '<', $now)->orWhere('absolute_expires_at', '<', $now))->delete();
        Sanctum::$personalAccessTokenModel::query()->where('name', 'like', self::PREFIX.'%')->where('expires_at', '<', now())->delete();
    }

    private static function entry(object $session, ?string $current): array
    {
        $metadata = is_string($session->metadata) ? (array) json_decode($session->metadata, true) : [];

        return array_filter([
            'id' => $session->session_id,
            'deviceId' => $session->device_id,
            'deviceName' => $metadata['deviceName'] ?? null,
            'current' => $current !== null && $session->session_id === $current,
            'loginAt' => $metadata['loginAt'] ?? null,
            'lastActiveAt' => CarbonImmutable::parse($session->created_at)->utc()->format('Y-m-d\TH:i:s.v\Z'),
        ], fn (mixed $value): bool => $value !== null);
    }

    private static function metadata(Request $request): array
    {
        $deviceName = self::deviceName($request->userAgent());
        $metadata = ['loginAt' => CarbonImmutable::now()->utc()->format('Y-m-d\TH:i:s.v\Z')];

        return $deviceName === null ? $metadata : $metadata + ['deviceName' => $deviceName];
    }

    /** "Chrome on macOS", or whichever half is known; the header is clamped before it is scanned. */
    private static function deviceName(?string $userAgent): ?string
    {
        if ($userAgent === null || $userAgent === '') {
            return null;
        }
        $agent = substr($userAgent, 0, 1024);
        $browser = self::first(self::BROWSERS, $agent);
        $os = self::first(self::SYSTEMS, $agent);

        return $browser !== null && $os !== null ? "{$browser} on {$os}" : ($browser ?? $os);
    }

    private static function first(array $patterns, string $agent): ?string
    {
        foreach ($patterns as $pattern => $name) {
            if (preg_match($pattern, $agent) === 1) {
                return $name;
            }
        }

        return null;
    }

    private static function cookieName(): string
    {
        $name = config('camis.users_permissions.sessions.cookie.name');

        return is_string($name) && $name !== '' ? $name : 'strapi_up_refresh';
    }

    private static function lifespan(string $key): int
    {
        return (int) config("camis.users_permissions.sessions.{$key}");
    }

    private static function stamp(CarbonImmutable $moment): string
    {
        return $moment->format('Y-m-d H:i:s.v');
    }
}
`;

export const emitSessionController = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Models\\User;
use App\\Support\\StrapiError;
use App\\Support\\StrapiSessions;
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\Request;

/** users-permissions' session routes, which Strapi serves in refresh mode only. */
final class SessionController extends Controller
{
    public function refresh(Request $request): JsonResponse
    {
        self::refreshOnly();
        $token = StrapiSessions::presented($request)
            ?? throw new StrapiError(400, 'BadRequestError', 'Missing refresh token');
        $tokens = StrapiSessions::rotate($token)
            ?? throw new StrapiError(401, 'UnauthorizedError', 'Invalid refresh token');

        return StrapiSessions::respond($request, $tokens);
    }

    /** One session (the request's own, by its refresh token or else its access token), a device's, or all. */
    public function logout(Request $request): JsonResponse
    {
        self::refreshOnly();
        $user = self::user($request);
        $deviceId = $request->json('deviceId');
        if ($request->json('scope') === 'all') {
            StrapiSessions::invalidate($user);
        } elseif (is_string($deviceId) && $deviceId !== '') {
            StrapiSessions::invalidate($user, $deviceId);
        } else {
            $session = StrapiSessions::sessionOf(StrapiSessions::presented($request)) ?? StrapiSessions::current($request);
            $session === null ? StrapiSessions::invalidate($user) : StrapiSessions::revoke($user, $session);
        }
        $response = response()->json(['ok' => true]);

        return StrapiSessions::cookieMode($request) ? $response->withCookie(StrapiSessions::forget()) : $response;
    }

    public function sessions(Request $request): JsonResponse
    {
        self::refreshOnly();

        return response()->json(['data' => StrapiSessions::list(self::user($request), StrapiSessions::current($request))]);
    }

    public function revoke(Request $request, string $sessionId): JsonResponse
    {
        self::refreshOnly();
        if (! StrapiSessions::revoke(self::user($request), $sessionId)) {
            throw new StrapiError(404, 'NotFoundError', 'Session not found');
        }

        return response()->json(['data' => new \\stdClass()]);
    }

    private static function refreshOnly(): void
    {
        if (! StrapiSessions::refreshMode()) {
            throw new StrapiError(404, 'NotFoundError', 'Not Found');
        }
    }

    /** An API token's request has no account, so no sessions of its own. */
    private static function user(Request $request): User
    {
        return $request->user() ?? throw new StrapiError(401, 'UnauthorizedError', 'Missing authentication');
    }
}
`;

/**
 * Roles and their permissions live in the IR rather than in an editable table, so no grant can
 * open users-permissions' role routes: Strapi forbids them so to every role it ships.
 */
export const emitRoleController = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Support\\StrapiError;

final class RoleController extends Controller
{
    public function __invoke(): never
    {
        throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
    }
}
`;
