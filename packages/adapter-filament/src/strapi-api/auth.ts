import { PHP_MARKER } from "../hooks/names";
import { phpSingleQuoted } from "../php-literal";

export const USERNAME_MIGRATION_PATH =
  "database/migrations/0001_01_02_000000_add_username_to_users_table.php";

export const emitUsernameMigration = (): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->string('username')->unique()->after('name');
        });
    }

    public function down(): void
    {
        Schema::table('users', function (Blueprint $table): void {
            $table->dropColumn('username');
        });
    }
};
`;

// Exported so the Strapi storage layout's own AuthController (strapi-api/storage/auth.ts) can
// reuse the identical wire shape and injection-safe quoting instead of redefining them.
export const strapiUser =
  "['id' => $user->id, 'username' => $user->username, 'email' => $user->email]";

/**
 * Strapi users-permissions' auth controller over Sanctum personal access tokens: local register
 * and login, the password routes and email confirmation, with Strapi's checks in Strapi's order.
 */
export const emitAuthController = (defaultRole: string | undefined): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Models\\User;
use App\\Support\\StrapiError;
use App\\Support\\StrapiProviders;
use App\\Support\\StrapiSessions;
use App\\Support\\StrapiUsers;
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\RedirectResponse;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Hash;${defaultRole !== undefined ? "\nuse Spatie\\Permission\\Models\\Role;" : ""}

class AuthController extends Controller
{
    private const REGISTER_KEYS = ['username', 'password', 'email'];

    public function register(Request $request): JsonResponse
    {
        $settings = StrapiUsers::advanced();
        if (! (bool) ($settings['allow_register'] ?? false)) {
            throw StrapiUsers::application('Register action is currently disabled');
        }
        $body = $request->json()->all();
        $invalid = array_diff(array_map('strval', array_keys($body)), self::REGISTER_KEYS);
        if ($invalid !== []) {
            throw StrapiError::validation('Invalid parameters: '.implode(', ', $invalid));
        }
        StrapiUsers::validate($body, ['email' => ['required', 'email'], 'username' => ['required'], 'password' => ['required', 'maxPassword']]);
${
  defaultRole !== undefined
    ? `        $role = Role::query()->where('name', ${phpSingleQuoted(defaultRole)})->first()
            ?? throw StrapiUsers::application('Impossible to find the default role');
`
    : ""
}        $email = mb_strtolower((string) $body['email']);
        $username = (string) $body['username'];
        $taken = User::query()->where(fn ($q) => $q->where('email', $email)->orWhere('username', $email)
            ->orWhere('username', $username)->orWhere('email', $username));
        if ($taken->exists()) {
            throw StrapiUsers::application('Email or Username are already taken');
        }
        $confirm = (bool) ($settings['email_confirmation'] ?? false);
        $user = StrapiUsers::add([
            'username' => $username,
            'email' => $email,
            'password' => Hash::make((string) $body['password']),
            'confirmed' => ! $confirm,
        ]);${defaultRole !== undefined ? "\n        $user->assignRole($role);" : ""}
        if ($confirm) {
            try {
                StrapiUsers::sendConfirmation($user);
            } catch (\\Throwable $error) {
                report($error);

                throw StrapiUsers::application('Error sending confirmation email');
            }

            return response()->json(['user' => StrapiUsers::wire($user)]);
        }

        return response()->json(StrapiSessions::registered($request, $user));
    }

    public function login(Request $request): JsonResponse
    {
        if (! StrapiProviders::enabled('email')) {
            throw StrapiUsers::application('This provider is disabled');
        }
        $body = $request->json()->all();
        StrapiUsers::validate($body, ['identifier' => ['required'], 'password' => ['required']]);
        $identifier = (string) $body['identifier'];
        $user = User::query()->where('provider', 'local')
            ->where(fn ($q) => $q->where('email', mb_strtolower($identifier))->orWhere('username', $identifier))
            ->first();
        if ($user === null || ($user->password ?? '') === '' || ! Hash::check((string) $body['password'], $user->password)) {
            throw StrapiError::validation('Invalid identifier or password');
        }
        if ((bool) (StrapiUsers::advanced()['email_confirmation'] ?? false) && ! (bool) $user->confirmed) {
            throw StrapiUsers::application('Your account email is not confirmed');
        }
        if ((bool) $user->blocked) {
            throw StrapiUsers::application('Your account has been blocked by an administrator');
        }

        return StrapiSessions::login($request, $user);
    }

    public function changePassword(Request $request): JsonResponse
    {
        $user = $request->user() ?? throw StrapiUsers::application('You must be authenticated to reset your password');
        $body = $request->json()->all();
        StrapiUsers::validate($body, ['password' => ['required', 'maxPassword'], 'passwordConfirmation' => ['required', 'same:password'], 'currentPassword' => ['required']]);
        if (! Hash::check((string) $body['currentPassword'], $user->password)) {
            throw StrapiError::validation('The provided current password is invalid');
        }
        if ($body['currentPassword'] === $body['password']) {
            throw StrapiError::validation('Your new password must be different than your current password');
        }
        $user->forceFill(['password' => Hash::make((string) $body['password'])])->save();

        return response()->json(StrapiSessions::reissue($user));
    }

    public function forgotPassword(Request $request): JsonResponse
    {
        $body = $request->json()->all();
        StrapiUsers::validate($body, ['email' => ['required', 'email']]);
        $user = User::query()->where('email', mb_strtolower((string) $body['email']))->first();
        if ($user === null || (bool) $user->blocked) {
            return response()->json(['ok' => true]);
        }
        $token = bin2hex(random_bytes(64));
        // Saved before sending, so an administrator can still hand out the link if the mail fails.
        $user->forceFill(['reset_password_token' => $token])->save();
        StrapiUsers::sendResetPassword($user, $token);

        return response()->json(['ok' => true]);
    }

    public function resetPassword(Request $request): JsonResponse
    {
        $body = $request->json()->all();
        StrapiUsers::validate($body, ['password' => ['required', 'maxPassword'], 'passwordConfirmation' => ['required', 'same:password'], 'code' => ['required']]);
        $user = User::query()->where('reset_password_token', (string) $body['code'])->first()
            ?? throw StrapiError::validation('Incorrect code provided');
        $user->forceFill(['reset_password_token' => null, 'password' => Hash::make((string) $body['password'])])->save();

        return response()->json(StrapiSessions::reissue($user));
    }

    public function emailConfirmation(Request $request): RedirectResponse
    {
        $query = $request->query();
        StrapiUsers::validate($query, ['confirmation' => ['required']]);
        $user = User::query()->where('confirmation_token', (string) $query['confirmation'])->first()
            ?? throw StrapiError::validation('Invalid token');
        $user->forceFill(['confirmed' => true, 'confirmation_token' => null])->save();
        $redirection = StrapiUsers::advanced()['email_confirmation_redirection'] ?? null;

        return redirect()->away(is_string($redirection) && $redirection !== '' ? $redirection : '/');
    }

    public function sendEmailConfirmation(Request $request): JsonResponse
    {
        $body = $request->json()->all();
        StrapiUsers::validate($body, ['email' => ['required', 'email']]);
        $user = User::query()->where('email', mb_strtolower((string) $body['email']))->first();
        if ($user === null) {
            return response()->json(['email' => $body['email'], 'sent' => true]);
        }
        if ((bool) $user->confirmed) {
            throw StrapiUsers::application('Already confirmed');
        }
        if ((bool) $user->blocked) {
            throw StrapiUsers::application('User blocked');
        }
        StrapiUsers::sendConfirmation($user);

        return response()->json(['email' => $user->email, 'sent' => true]);
    }
}
`;
