import { PHP_MARKER } from "../hooks/names";
import { phpSingleQuoted } from "../php-literal";

/**
 * Strapi users-permissions' sign-in providers: the settings it keeps per provider ("grant"), the
 * OAuth 1 and 2 round trips its connect middleware runs (oauth-connect, which replaced the
 * `grant` package), and each provider's profile check. Ported from strapi-php, which ports
 * upstream file for file; oauth-vectors.json is what it answers.
 */

export const PASSWORDLESS_MIGRATION_PATH =
  "database/migrations/0001_01_02_000004_allow_users_without_password.php";

export const emitPasswordlessMigration = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

// An account made through a sign-in provider has no password, as in Strapi.
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->string('password')->nullable()->change();
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->string('password')->nullable(false)->change();
        });
    }
};
`;

export const emitStrapiProviders = (defaultRole: string | undefined): string => String.raw`<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\Support;

use App\Models\User;${defaultRole !== undefined ? "\nuse Spatie\\Permission\\Models\\Role;" : ""}

/**
 * users-permissions' providers: Strapi's defaults for each (its providers-registry), the settings
 * an administrator gives them over those defaults, and the profile each one vouches for.
 */
final class StrapiProviders
{
    private const MAX_USERNAME_ATTEMPTS = 10;

    /** The built-in providers' OAuth endpoints (grant's oauth.json, which Strapi inlines). */
    public const ENDPOINTS = [
        'discord' => ['oauth' => 2, 'authorize_url' => 'https://discord.com/api/oauth2/authorize', 'access_url' => 'https://discord.com/api/oauth2/token', 'scope_delimiter' => ' '],
        'facebook' => ['oauth' => 2, 'authorize_url' => 'https://www.facebook.com/dialog/oauth', 'access_url' => 'https://graph.facebook.com/oauth/access_token'],
        'google' => ['oauth' => 2, 'authorize_url' => 'https://accounts.google.com/o/oauth2/v2/auth', 'access_url' => 'https://oauth2.googleapis.com/token', 'scope_delimiter' => ' '],
        'github' => ['oauth' => 2, 'authorize_url' => 'https://github.com/login/oauth/authorize', 'access_url' => 'https://github.com/login/oauth/access_token'],
        'microsoft' => ['oauth' => 2, 'authorize_url' => 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', 'access_url' => 'https://login.microsoftonline.com/common/oauth2/v2.0/token', 'scope_delimiter' => ' '],
        'twitter' => ['oauth' => 1, 'request_url' => 'https://api.twitter.com/oauth/request_token', 'authorize_url' => 'https://api.twitter.com/oauth/authenticate', 'access_url' => 'https://api.twitter.com/oauth/access_token'],
        'instagram' => ['oauth' => 2, 'authorize_url' => 'https://api.instagram.com/oauth/authorize', 'access_url' => 'https://api.instagram.com/oauth/access_token', 'scope_delimiter' => ' '],
        'vk' => ['oauth' => 2, 'authorize_url' => 'https://oauth.vk.com/authorize', 'access_url' => 'https://oauth.vk.com/access_token'],
        'twitch' => ['oauth' => 2, 'authorize_url' => 'https://id.twitch.tv/oauth2/authorize', 'access_url' => 'https://id.twitch.tv/oauth2/token', 'scope_delimiter' => ' '],
        'linkedin' => ['oauth' => 2, 'authorize_url' => 'https://www.linkedin.com/oauth/v2/authorization', 'access_url' => 'https://www.linkedin.com/oauth/v2/accessToken', 'scope_delimiter' => ' '],
        'cognito' => ['oauth' => 2, 'authorize_url' => 'https://[subdomain]/oauth2/authorize', 'access_url' => 'https://[subdomain]/oauth2/token', 'scope_delimiter' => ' '],
        'reddit' => ['oauth' => 2, 'authorize_url' => 'https://ssl.reddit.com/api/v1/authorize', 'access_url' => 'https://ssl.reddit.com/api/v1/access_token', 'token_endpoint_auth_method' => 'client_secret_basic'],
        'auth0' => ['oauth' => 2, 'authorize_url' => 'https://[subdomain].auth0.com/authorize', 'access_url' => 'https://[subdomain].auth0.com/oauth/token', 'scope_delimiter' => ' '],
        'cas' => ['oauth' => 2, 'authorize_url' => 'https://[subdomain]/oidc/authorize', 'access_url' => 'https://[subdomain]/oidc/token'],
        'patreon' => ['oauth' => 2, 'authorize_url' => 'https://www.patreon.com/oauth2/authorize', 'access_url' => 'https://www.patreon.com/api/oauth2/token', 'scope_delimiter' => ' '],
        'keycloak' => ['oauth' => 2, 'authorize_url' => 'https://[subdomain]/protocol/openid-connect/auth', 'access_url' => 'https://[subdomain]/protocol/openid-connect/token', 'scope_delimiter' => ' '],
    ];

    /**
     * Strapi's settings for a new project, keys and spellings included: some providers name the
     * front-end page they return to "callbackUrl", which the connect flow does not read.
     *
     * @return array<string, array<string, mixed>>
     */
    public static function defaults(): array
    {
        $auth = rtrim((string) config('app.url'), '/').'/api/auth';
        $provider = fn (string $icon, array $settings): array => ['icon' => $icon, 'enabled' => false, 'key' => '', 'secret' => ''] + $settings;

        return [
            'email' => ['icon' => 'envelope', 'enabled' => true],
            'discord' => $provider('discord', ['callbackUrl' => "{$auth}/discord/callback", 'scope' => ['identify', 'email']]),
            'facebook' => $provider('facebook-square', ['callbackUrl' => "{$auth}/facebook/callback", 'scope' => ['email']]),
            'google' => $provider('google', ['callbackUrl' => "{$auth}/google/callback", 'scope' => ['email']]),
            'github' => $provider('github', ['callbackUrl' => "{$auth}/github/callback", 'scope' => ['user', 'user:email']]),
            'microsoft' => $provider('windows', ['callbackUrl' => "{$auth}/microsoft/callback", 'scope' => ['user.read']]),
            'twitter' => $provider('twitter', ['callbackUrl' => "{$auth}/twitter/callback"]),
            'instagram' => $provider('instagram', ['callbackUrl' => "{$auth}/instagram/callback", 'scope' => ['user_profile']]),
            'vk' => $provider('vk', ['callbackUrl' => "{$auth}/vk/callback", 'scope' => ['email']]),
            'twitch' => $provider('twitch', ['callbackUrl' => "{$auth}/twitch/callback", 'scope' => ['user:read:email']]),
            'linkedin' => $provider('linkedin', ['callbackUrl' => "{$auth}/linkedin/callback", 'scope' => ['r_liteprofile', 'r_emailaddress']]),
            'cognito' => $provider('aws', ['subdomain' => 'my.subdomain.com', 'callback' => "{$auth}/cognito/callback", 'scope' => ['email', 'openid', 'profile']]),
            'reddit' => $provider('reddit', ['callback' => "{$auth}/reddit/callback", 'scope' => ['identity']]),
            'auth0' => $provider('', ['subdomain' => 'my-tenant.eu', 'callback' => "{$auth}/auth0/callback", 'scope' => ['openid', 'email', 'profile']]),
            'cas' => $provider('book', ['callback' => "{$auth}/cas/callback", 'scope' => ['openid email'], 'subdomain' => 'my.subdomain.com/cas']),
            'patreon' => $provider('', ['callback' => "{$auth}/patreon/callback", 'scope' => ['identity', 'identity[email]']]),
            'keycloak' => $provider('', ['subdomain' => 'myKeycloakProvider.com/realms/myrealm', 'callback' => "{$auth}/keycloak/callback", 'scope' => ['openid', 'email', 'profile']]),
        ];
    }

    /**
     * Each provider's settings: what the admin saved over Strapi's defaults, key by key, so a
     * saved list replaces the default list rather than merging into it.
     *
     * @return array<string, array<string, mixed>>
     */
    public static function settings(): array
    {
        $stored = StrapiSettings::get('users-permissions.grant');
        $settings = [];
        foreach (self::defaults() as $name => $defaults) {
            $saved = is_array($stored[$name] ?? null) ? $stored[$name] : [];
            $settings[$name] = array_replace($defaults, array_filter($saved, fn (mixed $value): bool => $value !== null));
        }

        return $settings;
    }

    /** @param array<string, mixed> $values */
    public static function configure(string $name, array $values): void
    {
        $stored = StrapiSettings::get('users-permissions.grant');
        $current = is_array($stored[$name] ?? null) ? $stored[$name] : [];
        StrapiSettings::merge('users-permissions.grant', [$name => array_replace($current, $values)]);
    }

    public static function enabled(string $name): bool
    {
        return (bool) (self::settings()[$name]['enabled'] ?? false);
    }

    /**
     * The account a provider's answer signs in: the one made through it for that email, else a
     * new confirmed one (Strapi's providers service).
     *
     * @param array<string, mixed> $grant
     */
    public static function connect(string $provider, array $grant): User
    {
        $accessToken = self::firstFilled($grant['access_token'] ?? null, $grant['code'] ?? null, $grant['oauth_token'] ?? null);
        if (! self::filled($accessToken) && ! self::filled($grant['id_token'] ?? null)) {
            throw new \RuntimeException('No access_token.');
        }
        $profile = self::profile($provider, $grant, $accessToken);
        $email = mb_strtolower(is_scalar($profile['email'] ?? null) ? (string) $profile['email'] : '');
        if ($email === '') {
            throw new \RuntimeException('Email was not available.');
        }
        $users = User::query()->where('email', $email)->get();
        $advanced = StrapiUsers::advanced();
        $user = $users->firstWhere('provider', $provider);
        if ($user === null && ! (bool) ($advanced['allow_register'] ?? false)) {
            throw new \RuntimeException('Register action is actually not available.');
        }
        if ($user !== null) {
            return $user;
        }
        if ($users->isNotEmpty() && (bool) ($advanced['unique_email'] ?? false)) {
            throw new \RuntimeException('Email is already taken.');
        }
${
  defaultRole !== undefined
    ? `        $role = Role::query()->where('name', ${phpSingleQuoted(defaultRole)})->first()
            ?? throw new \\RuntimeException('Impossible to find the default role');
`
    : ""
}        $named = is_string($profile['username'] ?? null) ? trim($profile['username']) : '';
        $user = StrapiUsers::add([
            'username' => self::validUsername($named !== '' ? $named : explode('@', $email)[0]),
            'email' => $email,
            'password' => null,
            'provider' => $provider,
            'confirmed' => true,
        ]);${defaultRole !== undefined ? "\n        $user->assignRole($role);" : ""}

        return $user;
    }

    /**
     * What the provider says of the signed-in account (Strapi's authCallback for it).
     *
     * @param array<string, mixed> $grant
     * @return array{username: mixed, email: mixed}
     */
    public static function profile(string $provider, array $grant, mixed $accessToken): array
    {
        $settings = self::settings();
        $setting = fn (string $key): string => StrapiOAuth::stringify($settings[$provider][$key] ?? 'undefined');

        return match ($provider) {
            'discord' => self::discord(self::body(StrapiOAuth::bearerGet('https://discord.com/api/users/@me', $accessToken))),
            'facebook' => self::requireEmail(self::body(StrapiOAuth::bearerGet('https://graph.facebook.com/me', $accessToken, ['fields' => 'name,email'])), 'name', 'Facebook'),
            'google' => self::google(self::body(StrapiOAuth::fetchJson('https://oauth2.googleapis.com/tokeninfo?access_token='.rawurlencode(StrapiOAuth::stringify($accessToken))))),
            'github' => self::github($accessToken),
            'microsoft' => self::microsoft(self::body(StrapiOAuth::bearerGet('https://graph.microsoft.com/v1.0/me', $accessToken))),
            'twitter' => self::twitter($grant, $accessToken, $settings['twitter'] ?? []),
            'instagram' => self::instagram(self::body(StrapiOAuth::bearerGet('https://graph.instagram.com/me', $accessToken, ['fields' => 'id,username']))),
            'vk' => self::vk($grant, $accessToken),
            'twitch' => self::twitch(self::body(StrapiOAuth::bearerGet('https://api.twitch.tv/helix/users', $accessToken, [], ['Client-Id' => $setting('key')]))),
            'linkedin' => self::linkedin($accessToken),
            'cognito' => self::cognito($grant, $settings['cognito'] ?? []),
            'reddit' => self::reddit(self::body(StrapiOAuth::bearerGet('https://oauth.reddit.com/api/v1/me', $accessToken, [], ['user-agent' => 'strapi']))),
            'auth0' => self::auth0(self::body(StrapiOAuth::bearerGet('https://'.$setting('subdomain').'.auth0.com/userinfo', $accessToken))),
            'cas' => self::cas(self::body(StrapiOAuth::bearerGet('https://'.$setting('subdomain').'/oidc/profile', $accessToken))),
            'patreon' => self::patreon(self::body(StrapiOAuth::bearerGet('https://www.patreon.com/api/oauth2/v2/identity?fields[user]=full_name,email,is_email_verified', $accessToken))),
            'keycloak' => self::keycloak(self::body(StrapiOAuth::bearerGet('https://'.$setting('subdomain').'/protocol/openid-connect/userinfo', $accessToken))),
            default => throw new \RuntimeException('Unknown auth provider'),
        };
    }

    private static function discord(array $body): array
    {
        if (($body['verified'] ?? null) !== true) {
            throw new \RuntimeException('Email not verified by Discord');
        }
        $discriminator = $body['discriminator'] ?? null;
        $username = self::filled($discriminator) && $discriminator !== '0'
            ? StrapiOAuth::stringify($body['username'] ?? null).'#'.StrapiOAuth::stringify($discriminator)
            : ($body['username'] ?? null);

        return ['username' => $username, 'email' => $body['email'] ?? null];
    }

    private static function requireEmail(array $body, string $usernameKey, string $label): array
    {
        if (! self::filled($body['email'] ?? null)) {
            throw new \RuntimeException("Email not verified by {$label}");
        }

        return ['username' => $body[$usernameKey] ?? null, 'email' => $body['email']];
    }

    private static function google(array $body): array
    {
        $verified = $body['verified_email'] ?? $body['email_verified'] ?? null;
        if ($verified !== true && $verified !== 'true') {
            throw new \RuntimeException('Email not verified by Google');
        }

        return ['username' => explode('@', StrapiOAuth::stringify($body['email'] ?? null))[0], 'email' => $body['email'] ?? null];
    }

    /** A public email must be one GitHub verified; without one, the primary must be verified. */
    private static function github(mixed $accessToken): array
    {
        $headers = ['user-agent' => 'strapi'];
        $user = self::body(StrapiOAuth::bearerGet('https://api.github.com/user', $accessToken, [], $headers));
        $listed = StrapiOAuth::bearerGet('https://api.github.com/user/emails', $accessToken, [], $headers);
        $emails = is_array($listed) && array_is_list($listed) ? array_filter($listed, 'is_array') : [];
        if (self::filled($user['email'] ?? null)) {
            foreach ($emails as $entry) {
                if (($entry['email'] ?? null) === $user['email'] && ($entry['verified'] ?? null) === true) {
                    return ['username' => $user['login'] ?? null, 'email' => $user['email']];
                }
            }

            throw new \RuntimeException('Email not verified by GitHub');
        }
        foreach ($emails as $entry) {
            if (($entry['primary'] ?? null) === true) {
                if (($entry['verified'] ?? null) !== true) {
                    break;
                }

                return ['username' => $user['login'] ?? null, 'email' => $entry['email'] ?? null];
            }
        }

        throw new \RuntimeException('Email not verified by GitHub');
    }

    private static function microsoft(array $body): array
    {
        return ['username' => $body['userPrincipalName'] ?? null, 'email' => $body['userPrincipalName'] ?? null];
    }

    private static function twitter(array $grant, mixed $accessToken, array $settings): array
    {
        $secret = $grant['access_secret'] ?? null;
        if (! self::filled($secret)) {
            throw new \RuntimeException('Twitter authentication requires a completed OAuth session');
        }
        $raw = is_array($grant['raw'] ?? null) ? $grant['raw'] : [];
        $body = self::body(StrapiOAuth::twitterGet(
            'https://api.twitter.com/1.1/account/verify_credentials.json',
            ['include_email' => 'true', 'screen_name' => $raw['screen_name'] ?? null],
            $settings['key'] ?? null,
            $settings['secret'] ?? null,
            $accessToken,
            $secret,
        ));

        return self::requireEmail($body, 'screen_name', 'Twitter');
    }

    private static function instagram(array $body): array
    {
        return ['username' => $body['username'] ?? null, 'email' => StrapiOAuth::stringify($body['username'] ?? 'undefined').'@strapi.io'];
    }

    private static function vk(array $grant, mixed $accessToken): array
    {
        $raw = is_array($grant['raw'] ?? null) ? $grant['raw'] : [];
        if (! self::filled($raw['email'] ?? null) || ! self::filled($raw['user_id'] ?? null)) {
            throw new \RuntimeException('VK authentication requires a completed OAuth session');
        }
        $body = self::body(StrapiOAuth::bearerGet('https://api.vk.com/method/users.get', $accessToken, ['user_ids' => $raw['user_id'], 'v' => '5.122']));
        $first = is_array($body['response'] ?? null) ? ($body['response'][0] ?? null) : null;
        if (! is_array($first) || $first === []) {
            throw new \RuntimeException('Invalid VK access token');
        }

        return [
            'username' => StrapiOAuth::stringify($first['last_name'] ?? 'undefined').' '.StrapiOAuth::stringify($first['first_name'] ?? 'undefined'),
            'email' => $raw['email'],
        ];
    }

    private static function twitch(array $body): array
    {
        $first = is_array($body['data'][0] ?? null) ? $body['data'][0] : [];
        if (! self::filled($first['email'] ?? null)) {
            throw new \RuntimeException('Email not verified by Twitch');
        }

        return ['username' => $first['login'] ?? null, 'email' => $first['email']];
    }

    private static function linkedin(mixed $accessToken): array
    {
        $profile = self::body(StrapiOAuth::bearerGet('https://api.linkedin.com/v2/me', $accessToken));
        $emails = self::body(StrapiOAuth::bearerGet('https://api.linkedin.com/v2/emailAddress?q=members&projection=(elements*(handle~))', $accessToken));
        if (! is_array($emails['elements'] ?? null)) {
            throw new \RuntimeException("Cannot read properties of undefined (reading '0')");
        }
        $email = is_array($emails['elements'][0]['handle~'] ?? null) ? $emails['elements'][0]['handle~'] : [];
        if (! self::filled($email['emailAddress'] ?? null)) {
            throw new \RuntimeException('Email not verified by LinkedIn');
        }

        return ['username' => $profile['localizedFirstName'] ?? null, 'email' => $email['emailAddress']];
    }

    private static function cognito(array $grant, array $settings): array
    {
        $jwks = $settings['jwksurl'] ?? null;
        if (! is_string($jwks) || parse_url($jwks, PHP_URL_SCHEME) === null) {
            throw new \RuntimeException('Invalid URL');
        }
        if (! self::filled($grant['id_token'] ?? null)) {
            throw new \RuntimeException('Cognito authentication requires a completed OAuth session');
        }
        $claims = StrapiOAuth::verifyIdToken(StrapiOAuth::stringify($grant['id_token']), $jwks);
        if (($claims['email_verified'] ?? null) !== true) {
            throw new \RuntimeException('Email not verified by Cognito');
        }

        return ['username' => $claims['cognito:username'] ?? null, 'email' => $claims['email'] ?? null];
    }

    private static function reddit(array $body): array
    {
        return ['username' => $body['name'] ?? null, 'email' => StrapiOAuth::stringify($body['name'] ?? 'undefined').'@strapi.io'];
    }

    private static function auth0(array $body): array
    {
        if (self::filled($body['email'] ?? null) && ($body['email_verified'] ?? null) !== true) {
            throw new \RuntimeException('Email not verified by Auth0');
        }
        $username = self::firstFilled($body['username'] ?? null, $body['nickname'] ?? null, $body['name'] ?? null);
        $username = self::filled($username) ? $username : explode('@', StrapiOAuth::stringify($body['email'] ?? null))[0];
        $email = self::filled($body['email'] ?? null)
            ? $body['email']
            : preg_replace('/\s+/', '.', StrapiOAuth::stringify($username)).'@strapi.io';

        return ['username' => $username, 'email' => $email];
    }

    private static function cas(array $body): array
    {
        $attributes = is_array($body['attributes'] ?? null) ? $body['attributes'] : [];
        if (self::filled($body['attributes'] ?? null)) {
            $username = self::filled($attributes['strapiusername'] ?? null) ? $attributes['strapiusername'] : self::firstFilled($body['id'] ?? null, $body['sub'] ?? null);
            $email = self::firstFilled($attributes['strapiemail'] ?? null, $attributes['email'] ?? null);
        } else {
            $username = self::firstFilled($body['strapiusername'] ?? null, $body['id'] ?? null, $body['sub'] ?? null);
            $email = self::firstFilled($body['strapiemail'] ?? null, $body['email'] ?? null);
        }
        if (! self::filled($username) || ! self::filled($email)) {
            logger()->warning('CAS Response Body did not contain required attributes: '.json_encode($body, JSON_UNESCAPED_SLASHES));
        }
        $verified = $body['email_verified'] ?? ($attributes['email_verified'] ?? null);
        if (self::filled($email) && $verified !== true) {
            throw new \RuntimeException('Email not verified by CAS');
        }

        return ['username' => $username, 'email' => $email];
    }

    private static function patreon(array $body): array
    {
        $patron = is_array($body['data']['attributes'] ?? null) ? $body['data']['attributes'] : [];
        if (($patron['is_email_verified'] ?? null) !== true) {
            throw new \RuntimeException('Email not verified by Patreon');
        }

        return ['username' => $patron['full_name'] ?? null, 'email' => $patron['email'] ?? null];
    }

    private static function keycloak(array $body): array
    {
        if (($body['email_verified'] ?? null) !== true) {
            throw new \RuntimeException('Email not verified by Keycloak');
        }

        return ['username' => $body['preferred_username'] ?? null, 'email' => $body['email'] ?? null];
    }

    /** The name the provider gave, unless it is short or taken; then with four digits, then a UUID. */
    private static function validUsername(string $base): string
    {
        $attempt = 0;
        do {
            $candidate = $attempt === 0 && mb_strlen($base) >= 3 ? $base : $base.random_int(1000, 9998);
            $taken = User::query()->where('username', $candidate)->exists();
            $attempt++;
        } while ($taken && $attempt <= self::MAX_USERNAME_ATTEMPTS);

        return $taken ? (string) \Illuminate\Support\Str::uuid() : $candidate;
    }

    private static function body(mixed $body): array
    {
        return is_array($body) ? $body : [];
    }

    private static function filled(mixed $value): bool
    {
        return $value !== null && $value !== false && $value !== '' && $value !== 0 && $value !== 0.0 && $value !== [];
    }

    /** JavaScript's a || b || c: the first filled value, else the last. */
    private static function firstFilled(mixed ...$values): mixed
    {
        foreach ($values as $value) {
            if (self::filled($value)) {
                return $value;
            }
        }

        return $values === [] ? null : $values[array_key_last($values)];
    }
}
`;

export const emitStrapiOAuth = (): string => String.raw`<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\Support;

use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

/**
 * The OAuth round trip of Strapi's connect middleware: /connect/:provider sends the browser to
 * the provider with a state kept in the session, and its callback trades the code for tokens,
 * keeps them in the session and sends the browser to the front end, which then signs in with
 * /auth/:provider/callback. Requests to providers go through Laravel's HTTP client.
 */
final class StrapiOAuth
{
    private const SESSION_KEY = 'strapi_grant';

    /** @return array<string, mixed>|null */
    public static function grant(Request $request): ?array
    {
        $grant = $request->session()->get(self::SESSION_KEY);

        return is_array($grant) ? $grant : null;
    }

    /** @param array<string, mixed> $grant */
    public static function setGrant(Request $request, array $grant): void
    {
        $request->session()->put(self::SESSION_KEY, $grant);
    }

    public static function redirectUri(string $provider): string
    {
        return rtrim((string) config('app.url'), '/').'/api/connect/'.$provider.'/callback';
    }

    /**
     * A provider's endpoints with its settings, or null when it has none to run with.
     *
     * @param array<string, mixed> $settings
     * @return array<string, mixed>|null
     */
    public static function provider(string $name, array $settings): ?array
    {
        $endpoints = StrapiProviders::ENDPOINTS[$name] ?? array_intersect_key($settings, array_flip(['oauth', 'authorize_url', 'access_url', 'request_url', 'scope_delimiter', 'token_endpoint_auth_method']));
        $filled = fn (string $key): bool => ! in_array($endpoints[$key] ?? null, [null, '', false], true);
        if (! $filled('authorize_url') || ! $filled('access_url') || (($endpoints['oauth'] ?? null) === 1 && ! $filled('request_url'))) {
            return null;
        }

        return array_filter(['name' => $name] + $endpoints + [
            'key' => $settings['key'] ?? null,
            'secret' => $settings['secret'] ?? null,
            'scope' => $settings['scope'] ?? null,
            'subdomain' => $settings['subdomain'] ?? null,
            'callback' => $settings['callback'] ?? null,
            'redirect_uri' => self::redirectUri($name),
        ], fn (mixed $value): bool => $value !== null);
    }

    /** @param array<string, mixed> $provider */
    public static function start(Request $request, array $provider): RedirectResponse
    {
        $dynamic = self::grant($request)['dynamic'] ?? null;
        $kept = is_array($dynamic) && $dynamic !== [] ? ['dynamic' => $dynamic] : [];
        if (($provider['oauth'] ?? null) === 1) {
            $token = self::oauth1Request('POST', (string) $provider['request_url'], $provider['key'] ?? null, $provider['secret'] ?? null, null, null, ['oauth_callback' => $provider['redirect_uri']]);
            self::setGrant($request, $kept + ['provider' => $provider['name'], 'request' => $token]);

            return redirect()->away($provider['authorize_url'].'?oauth_token='.rawurlencode(self::stringify($token['oauth_token'] ?? 'undefined')));
        }
        $state = bin2hex(random_bytes(20));
        self::setGrant($request, $kept + ['provider' => $provider['name'], 'state' => $state]);

        return redirect()->away(self::authorizeUrl($provider).'&state='.rawurlencode($state));
    }

    /**
     * Back from the provider: any failure goes to the front end as error and error_description,
     * and leaves no tokens in the session.
     *
     * @param array<string, mixed> $provider
     */
    public static function finish(Request $request, array $provider, string $callbackUrl): RedirectResponse
    {
        try {
            if (($provider['oauth'] ?? null) === 1) {
                $session = self::grant($request) ?? [];
                $requested = is_array($session['request'] ?? null) ? $session['request'] : [];
                $oauthToken = $request->query('oauth_token');
                if (in_array($requested['oauth_token'] ?? null, [null, ''], true) || $oauthToken !== $requested['oauth_token']) {
                    throw new \RuntimeException('OAuth1 token mismatch');
                }
                $tokens = self::oauth1Request('POST', (string) $provider['access_url'], $provider['key'] ?? null, $provider['secret'] ?? null, $oauthToken, $requested['oauth_token_secret'] ?? null, ['oauth_verifier' => $request->query('oauth_verifier')]);
            } else {
                $error = $request->query('error');
                if ($error !== null && $error !== '') {
                    self::setGrant($request, []);

                    return self::redirectWithPayload($callbackUrl, ['error' => $error, 'error_description' => $request->query('error_description')]);
                }
                $code = $request->query('code');
                if ($code === null || $code === '') {
                    throw new \RuntimeException('OAuth2 missing code parameter');
                }
                // A session without a state is refused too, which closes login CSRF.
                $state = self::grant($request)['state'] ?? null;
                if (in_array($state, [null, ''], true) || $request->query('state') !== $state) {
                    throw new \RuntimeException('OAuth2 state mismatch');
                }
                $tokens = self::exchange($provider, (string) $code);
            }
            self::setGrant($request, ['response' => self::trim(self::tokensToPayload($provider, $tokens), (string) $provider['name'])]);

            return self::redirectWithPayload($callbackUrl, []);
        } catch (\Throwable $error) {
            self::setGrant($request, []);

            return self::redirectWithPayload($callbackUrl, ['error' => 'oauth_error', 'error_description' => $error->getMessage()]);
        }
    }

    /**
     * A front-end page asked for in the connect request must be the configured one, on its origin
     * and path; its query may differ (Strapi's default callback validator).
     */
    public static function validCallback(mixed $callback, mixed $configured): bool
    {
        $page = is_string($callback) ? parse_url($callback) : false;
        $known = is_string($configured) ? parse_url($configured) : false;
        $absolute = fn (mixed $u): bool => is_array($u) && isset($u['scheme']) && (isset($u['host']) || ! in_array(strtolower($u['scheme']), ['http', 'https'], true));
        if (! $absolute($page) || ! $absolute($known)) {
            return false;
        }
        $origin = function (array $u): string {
            $scheme = strtolower((string) $u['scheme']);
            $port = isset($u['port']) && ! (($scheme === 'http' && (int) $u['port'] === 80) || ($scheme === 'https' && (int) $u['port'] === 443)) ? ':'.$u['port'] : '';

            return $scheme.'://'.strtolower((string) ($u['host'] ?? '')).$port;
        };
        $path = fn (array $u): string => isset($u['path']) && $u['path'] !== '' ? (string) $u['path'] : '/';

        return $origin($page) === $origin($known) && $path($page) === $path($known);
    }

    /** @param array<string, mixed> $payload */
    public static function redirectWithPayload(string $callbackUrl, array $payload): RedirectResponse
    {
        $params = [];
        foreach ($payload as $key => $value) {
            if ($key === 'raw') {
                foreach (is_array($value) ? $value : [] as $rawKey => $rawValue) {
                    $params["raw[{$rawKey}]"] = self::stringify($rawValue);
                }
            } elseif ($value !== null) {
                $params[(string) $key] = self::stringify($value);
            }
        }
        $hash = strpos($callbackUrl, '#');
        $fragment = $hash === false ? '' : substr($callbackUrl, $hash);
        $base = $hash === false ? $callbackUrl : substr($callbackUrl, 0, $hash);
        $base = explode('?', $base, 2)[0];
        $search = self::serialize(array_map(null, array_keys($params), array_values($params)));

        return redirect()->away($base.($search !== '' ? '?'.$search : '').$fragment);
    }

    /** @param array<string, mixed> $provider */
    private static function authorizeUrl(array $provider): string
    {
        $key = self::stringify($provider['key'] ?? null);
        $params = [['client_id', $key], ['response_type', 'code'], ['redirect_uri', self::stringify($provider['redirect_uri'])]];
        $scope = self::scope($provider['scope'] ?? null, is_string($provider['scope_delimiter'] ?? null) ? $provider['scope_delimiter'] : ',');
        if ($scope !== null) {
            $params[] = ['scope', $scope];
        }
        // An Instagram app with a numeric id signs in through Facebook's app_id.
        if ($provider['name'] === 'instagram' && preg_match('/^\d+$/', $key) === 1) {
            $params = array_values(array_filter($params, fn (array $p): bool => $p[0] !== 'client_id'));
            $params[] = ['app_id', $key];
            $params = array_map(fn (array $p): array => $p[0] === 'scope' ? ['scope', str_replace(' ', ',', $p[1])] : $p, $params);
        }

        return self::subdomain((string) $provider['authorize_url'], $provider['subdomain'] ?? null).'?'.self::serialize($params);
    }

    /**
     * @param array<string, mixed> $provider
     * @return array<string, mixed>
     */
    private static function exchange(array $provider, string $code): array
    {
        $key = self::stringify($provider['key'] ?? null);
        $secret = self::stringify($provider['secret'] ?? null);
        $body = ['grant_type' => 'authorization_code', 'code' => $code, 'redirect_uri' => self::stringify($provider['redirect_uri']), 'client_id' => $key, 'client_secret' => $secret];
        $headers = ['Content-Type' => 'application/x-www-form-urlencoded'];
        if (($provider['token_endpoint_auth_method'] ?? null) === 'client_secret_basic') {
            $headers['Authorization'] = 'Basic '.base64_encode("{$key}:{$secret}");
            unset($body['client_id'], $body['client_secret']);
        }
        if ($provider['name'] === 'instagram' && preg_match('/^\d+$/', $key) === 1) {
            unset($body['client_id'], $body['client_secret']);
            $body += ['app_id' => $key, 'app_secret' => $secret];
        }
        $response = self::fetch(self::subdomain((string) $provider['access_url'], $provider['subdomain'] ?? null), 'POST', $headers, self::serialize(array_map(null, array_keys($body), array_values($body))));
        $output = str_contains($response['headers']['content-type'] ?? '', 'application/json')
            ? (is_array($json = self::json($response)) ? $json : [])
            : array_column(self::parse($response['body']), 1, 0);
        if (! $response['ok']) {
            $message = $output['error_description'] ?? $output['error'] ?? null;

            throw new \RuntimeException(is_scalar($message) && (string) $message !== '' ? (string) $message : "Token exchange failed ({$response['status']})");
        }

        return $output;
    }

    /**
     * @param array<string, mixed> $provider
     * @param array<string, mixed> $tokens
     * @return array<string, mixed>
     */
    private static function tokensToPayload(array $provider, array $tokens): array
    {
        $filled = fn (string $key): bool => ! in_array($tokens[$key] ?? null, [null, '', false, 0], true);
        $data = ['raw' => $tokens];
        $keys = ($provider['oauth'] ?? null) === 1
            ? ['access_token' => 'oauth_token', 'access_secret' => 'oauth_token_secret']
            : ['id_token' => 'id_token', 'access_token' => 'access_token', 'refresh_token' => 'refresh_token'];
        foreach ($keys as $to => $from) {
            if ($filled($from)) {
                $data[$to] = $tokens[$from];
            }
        }

        return $data;
    }

    /**
     * What the session keeps of a provider's answer: only what signing in reads.
     *
     * @param array<string, mixed> $grant
     * @return array<string, mixed>
     */
    private static function trim(array $grant, string $provider): array
    {
        $raw = is_array($grant['raw'] ?? null) ? $grant['raw'] : [];
        $kept = match ($provider) {
            'cognito' => ['id_token' => $grant['id_token'] ?? null],
            'twitter' => [
                'access_token' => $grant['access_token'] ?? null,
                'access_secret' => $grant['access_secret'] ?? null,
                'raw' => in_array($raw['screen_name'] ?? null, [null, '', false, 0], true) ? null : ['screen_name' => $raw['screen_name']],
            ],
            'vk' => [
                'access_token' => $grant['access_token'] ?? null,
                'raw' => ($raw['email'] ?? null) !== null && ($raw['user_id'] ?? null) !== null ? ['email' => $raw['email'], 'user_id' => $raw['user_id']] : null,
            ],
            default => ['access_token' => $grant['access_token'] ?? null, 'oauth_token' => $grant['oauth_token'] ?? null, 'id_token' => $grant['id_token'] ?? null],
        };

        return array_filter($kept, fn (mixed $value): bool => $value !== null);
    }

    private static function scope(mixed $scope, string $delimiter): ?string
    {
        if (is_array($scope)) {
            $joined = implode($delimiter, array_map(self::stringify(...), array_filter($scope, fn (mixed $s): bool => ! in_array($s, [null, '', false, 0], true))));

            return $joined !== '' ? $joined : null;
        }

        return in_array($scope, [null, '', false, 0], true) ? null : self::stringify($scope);
    }

    private static function subdomain(string $url, mixed $subdomain): string
    {
        $at = strpos($url, '[subdomain]');

        return in_array($subdomain, [null, '', false], true) || $at === false ? $url : substr_replace($url, self::stringify($subdomain), $at, strlen('[subdomain]'));
    }

    /**
     * An OAuth 1 request signed with HMAC-SHA1 (RFC 5849), its form-encoded answer decoded.
     *
     * @param array<string, mixed> $params
     * @return array<string, string>
     */
    private static function oauth1Request(string $method, string $url, mixed $consumerKey, mixed $consumerSecret, mixed $token, mixed $tokenSecret, array $params): array
    {
        $response = self::fetch($url, $method, ['Authorization' => self::oauth1Header($method, $url, $params, $consumerKey, $consumerSecret, $token, $tokenSecret)]);
        if (! $response['ok']) {
            throw new \RuntimeException($response['body'] !== '' ? $response['body'] : "OAuth1 request failed ({$response['status']})");
        }

        return array_column(self::parse($response['body']), 1, 0);
    }

    /** @param array<string, mixed> $params */
    private static function oauth1Header(string $method, string $url, array $params, mixed $consumerKey, mixed $consumerSecret, mixed $token, mixed $tokenSecret): string
    {
        $parameters = [
            'oauth_consumer_key' => self::stringify($consumerKey),
            'oauth_nonce' => bin2hex(random_bytes(16)),
            'oauth_signature_method' => 'HMAC-SHA1',
            'oauth_timestamp' => (string) time(),
            'oauth_version' => '1.0',
        ] + (in_array($token, [null, ''], true) ? [] : ['oauth_token' => self::stringify($token)]);
        foreach ($params as $key => $value) {
            $parameters[(string) $key] = self::stringify($value);
        }
        ksort($parameters, SORT_STRING);
        $pairs = implode('&', array_map(fn (string $key, string $value): string => rawurlencode($key).'='.rawurlencode($value), array_keys($parameters), $parameters));
        $base = implode('&', [strtoupper($method), rawurlencode($url), rawurlencode($pairs)]);
        $signingKey = rawurlencode(self::stringify($consumerSecret)).'&'.rawurlencode($tokenSecret === null ? '' : self::stringify($tokenSecret));
        $parameters['oauth_signature'] = base64_encode(hash_hmac('sha1', $base, $signingKey, true));
        ksort($parameters, SORT_STRING);

        return 'OAuth '.implode(', ', array_map(fn (string $key, string $value): string => rawurlencode($key).'="'.rawurlencode($value).'"', array_keys($parameters), $parameters));
    }

    /**
     * A Twitter API read signed for the user: the query is signed as parameters, not in the URL.
     *
     * @param array<string, mixed> $query
     */
    public static function twitterGet(string $url, array $query, mixed $consumerKey, mixed $consumerSecret, mixed $token, mixed $tokenSecret): mixed
    {
        $signed = array_map(self::stringify(...), array_filter($query, fn (mixed $value): bool => $value !== null));
        $response = self::fetch(self::withQuery($url, $signed), 'GET', ['Authorization' => self::oauth1Header('GET', $url, $signed, $consumerKey, $consumerSecret, $token, $tokenSecret)]);
        $body = self::json($response);
        if (! $response['ok']) {
            $message = is_array($body) ? ($body['errors'][0]['message'] ?? null) : null;

            throw new \RuntimeException(is_string($message) && $message !== '' ? $message : "Twitter API error ({$response['status']})");
        }

        return $body;
    }

    /**
     * The claims of an RS256 id token signed by one of the provider's published keys.
     *
     * @return array<string, mixed>
     */
    public static function verifyIdToken(string $idToken, string $jwksUrl): array
    {
        $parts = explode('.', $idToken);
        $header = count($parts) === 3 ? json_decode(self::base64UrlDecode($parts[0]), true) : null;
        $claims = count($parts) === 3 ? json_decode(self::base64UrlDecode($parts[1]), true) : null;
        if (! is_array($header) || in_array($header['kid'] ?? null, [null, ''], true) || ! is_array($claims)) {
            throw new \RuntimeException('The provided token is not valid');
        }
        $response = self::fetch($jwksUrl);
        $keys = $response['ok'] && is_array($jwks = self::json($response)) && is_array($jwks['keys'] ?? null) ? $jwks['keys'] : [];
        $jwk = null;
        foreach ($keys as $candidate) {
            if (is_array($candidate) && ($candidate['kid'] ?? null) === $header['kid']) {
                $jwk = $candidate;
                break;
            }
        }
        $key = $jwk === null ? false : self::publicKey($jwk);
        $now = time();
        if ($key === false
            || ($header['alg'] ?? null) !== 'RS256'
            || openssl_verify("{$parts[0]}.{$parts[1]}", self::base64UrlDecode($parts[2]), $key, OPENSSL_ALGO_SHA256) !== 1
            || (isset($claims['nbf']) && is_numeric($claims['nbf']) && (int) $claims['nbf'] > $now)
            || (isset($claims['exp']) && is_numeric($claims['exp']) && $now >= (int) $claims['exp'])) {
            throw new \RuntimeException('There was an error verifying the token');
        }

        return $claims;
    }

    /** An RSA JWK as a key OpenSSL reads: its modulus and exponent in a DER SubjectPublicKeyInfo. */
    private static function publicKey(array $jwk): \OpenSSLAsymmetricKey|false
    {
        if (($jwk['kty'] ?? null) !== 'RSA' || ! is_string($jwk['n'] ?? null) || ! is_string($jwk['e'] ?? null)) {
            return false;
        }
        $length = function (int $length): string {
            if ($length < 0x80) {
                return chr($length);
            }
            $bytes = ltrim(pack('N', $length), "\x00");

            return chr(0x80 | strlen($bytes)).$bytes;
        };
        $integer = function (string $bytes) use ($length): string {
            $bytes = ltrim($bytes, "\x00");
            if ($bytes === '' || (ord($bytes[0]) & 0x80) !== 0) {
                $bytes = "\x00".$bytes;
            }

            return "\x02".$length(strlen($bytes)).$bytes;
        };
        $sequence = fn (string $content): string => "\x30".$length(strlen($content)).$content;
        $rsa = $sequence($integer(self::base64UrlDecode($jwk['n'])).$integer(self::base64UrlDecode($jwk['e'])));
        // rsaEncryption (1.2.840.113549.1.1.1) with NULL parameters
        $spki = $sequence($sequence("\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01\x05\x00")."\x03".$length(strlen($rsa) + 1)."\x00".$rsa);

        return openssl_pkey_get_public("-----BEGIN PUBLIC KEY-----\n".chunk_split(base64_encode($spki), 64, "\n")."-----END PUBLIC KEY-----\n");
    }

    /**
     * A provider read with the access token, its JSON answer decoded; an error status throws the
     * provider's message.
     *
     * @param array<string, mixed> $query
     * @param array<string, string> $headers
     */
    public static function bearerGet(string $url, mixed $accessToken, array $query = [], array $headers = []): mixed
    {
        return self::fetchJson($query === [] ? $url : self::withQuery($url, $query), ['Authorization' => 'Bearer '.self::stringify($accessToken)] + $headers);
    }

    /** @param array<string, string> $headers */
    public static function fetchJson(string $url, array $headers = []): mixed
    {
        $response = self::fetch($url, 'GET', $headers);
        $body = json_decode($response['body'], true);
        if (! str_contains($response['headers']['content-type'] ?? '', 'application/json') && json_last_error() !== JSON_ERROR_NONE) {
            $body = $response['body'];
        }
        if (! $response['ok']) {
            $message = is_array($body) ? ($body['error_description'] ?? $body['error'] ?? $body['message'] ?? null) : $body;

            throw new \RuntimeException(is_scalar($message) && (string) $message !== '' ? (string) $message : "HTTP {$response['status']}");
        }

        return $body;
    }

    /**
     * @param array<string, string> $headers
     * @return array{ok: bool, status: int, headers: array<string, string>, body: string}
     */
    private static function fetch(string $url, string $method = 'GET', array $headers = [], ?string $body = null): array
    {
        $request = Http::withHeaders($headers)->timeout(10);
        $response = $body === null
            ? $request->send($method, $url)
            : $request->withBody($body, $headers['Content-Type'] ?? 'application/x-www-form-urlencoded')->send($method, $url);
        $lowered = [];
        foreach ($response->headers() as $name => $values) {
            $lowered[strtolower((string) $name)] = implode(', ', (array) $values);
        }

        return ['ok' => $response->successful(), 'status' => $response->status(), 'headers' => $lowered, 'body' => $response->body()];
    }

    /** @param array{body: string} $response */
    private static function json(array $response): mixed
    {
        return json_decode($response['body'], true, 512, JSON_THROW_ON_ERROR);
    }

    /** @param array<string, mixed> $params */
    private static function withQuery(string $url, array $params): string
    {
        $hash = strpos($url, '#');
        $fragment = $hash === false ? '' : substr($url, $hash);
        [$base, $query] = array_pad(explode('?', $hash === false ? $url : substr($url, 0, $hash), 2), 2, '');
        $pairs = self::parse($query);
        foreach ($params as $key => $value) {
            if ($value === null) {
                continue;
            }
            $key = (string) $key;
            $found = false;
            $next = [];
            foreach ($pairs as [$k, $v]) {
                if ($k !== $key) {
                    $next[] = [$k, $v];
                } elseif (! $found) {
                    $next[] = [$k, self::stringify($value)];
                    $found = true;
                }
            }
            $pairs = $found ? $next : [...$next, [$key, self::stringify($value)]];
        }
        $search = self::serialize($pairs);

        return $base.($search !== '' ? '?'.$search : '').$fragment;
    }

    /** @return list<array{0: string, 1: string}> */
    private static function parse(string $query): array
    {
        $pairs = [];
        foreach (explode('&', ltrim($query, '?')) as $part) {
            if ($part !== '') {
                [$name, $value] = array_pad(explode('=', $part, 2), 2, '');
                $pairs[] = [urldecode($name), urldecode($value)];
            }
        }

        return $pairs;
    }

    /** URLSearchParams' serialization: form encoding, with * left as it is. */
    private static function serialize(array $pairs): string
    {
        $encode = fn (string $s): string => str_replace('%2A', '*', urlencode($s));

        return implode('&', array_map(fn (array $p): string => $encode((string) $p[0]).'='.$encode((string) $p[1]), $pairs));
    }

    /** JavaScript's String(value), which strapi-php's provider code relies on. */
    public static function stringify(mixed $value): string
    {
        return match (true) {
            $value === true => 'true',
            $value === false => 'false',
            $value === null => 'null',
            is_array($value) => implode(',', array_map(self::stringify(...), $value)),
            is_scalar($value) => (string) $value,
            default => '',
        };
    }

    private static function base64UrlDecode(string $value): string
    {
        return (string) base64_decode(strtr($value, '-_', '+/').str_repeat('=', (4 - strlen($value) % 4) % 4));
    }
}
`;

export const emitConnectController = (): string => String.raw`<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Support\StrapiError;
use App\Support\StrapiOAuth;
use App\Support\StrapiProviders;
use App\Support\StrapiSessions;
use App\Support\StrapiUsers;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;

/** users-permissions' connect routes and its provider sign-in (auth.connect, auth.callback). */
final class ConnectController extends Controller
{
    public function connect(Request $request, string $provider): RedirectResponse
    {
        $settings = self::enabled($provider);
        $callback = $request->query('callback') ?? (StrapiOAuth::grant($request)['dynamic']['callback'] ?? null);
        if ($callback !== null) {
            if (! StrapiOAuth::validCallback($callback, $settings['callback'] ?? null)) {
                throw StrapiError::validation('Invalid callback URL provided', ['callback' => $callback]);
            }
            // Kept across the provider's redirect, which the request itself does not survive.
            $grant = StrapiOAuth::grant($request) ?? [];
            $grant['dynamic'] = ['callback' => $callback] + (is_array($grant['dynamic'] ?? null) ? $grant['dynamic'] : []);
            StrapiOAuth::setGrant($request, $grant);
            $settings['callback'] = $callback;
        }

        return StrapiOAuth::start($request, self::runnable($provider, $settings));
    }

    public function callback(Request $request, string $provider): RedirectResponse
    {
        $settings = self::enabled($provider);
        $callback = StrapiOAuth::grant($request)['dynamic']['callback'] ?? null;
        if (! in_array($callback, [null, '', false], true)) {
            $settings['callback'] = $callback;
        }
        $runnable = self::runnable($provider, $settings);
        $front = $settings['callback'] ?? null;
        if (! is_string($front) || $front === '') {
            throw StrapiUsers::application('Provider callback URL is not configured');
        }

        return StrapiOAuth::finish($request, $runnable, $front);
    }

    /** Signs in with what the provider's round trip left in the session. */
    public function signIn(Request $request, string $provider): JsonResponse
    {
        if ($provider === 'local') {
            return app(AuthController::class)->login($request);
        }
        self::enabled($provider);
        try {
            $grant = StrapiOAuth::grant($request)['response'] ?? null;
            if (! is_array($grant) || $grant === []) {
                throw StrapiUsers::application('OAuth authentication requires a completed provider session');
            }
            $user = StrapiProviders::connect($provider, $grant);
            if ((bool) $user->blocked) {
                throw new StrapiError(403, 'ForbiddenError', 'Your account has been blocked by an administrator');
            }

            return StrapiSessions::login($request, $user);
        } catch (\Throwable $error) {
            // Strapi answers every failure here as an ApplicationError with its message.
            throw StrapiUsers::application($error->getMessage());
        }
    }

    /** @return array<string, mixed> */
    private static function enabled(string $provider): array
    {
        $settings = StrapiProviders::settings()[$provider] ?? null;
        if (! is_array($settings) || ! (bool) ($settings['enabled'] ?? false)) {
            throw StrapiUsers::application('This provider is disabled');
        }

        return $settings;
    }

    /**
     * @param array<string, mixed> $settings
     * @return array<string, mixed>
     */
    private static function runnable(string $provider, array $settings): array
    {
        return StrapiOAuth::provider($provider, $settings) ?? throw StrapiUsers::application('Unknown OAuth provider');
    }
}
`;
