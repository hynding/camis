import { PHP_MARKER } from "../../hooks/names";
import { phpSingleQuoted, strapiUser } from "../auth";

/** Strapi's own default role for a freshly registered user, when the caller supplies none. */
const STRAPI_DEFAULT_ROLE = "authenticated";

/**
 * The Strapi-storage layout's `App\Http\Controllers\Api\AuthController` — same FQCN as the
 * Sanctum one (`../auth.ts`); only one is ever emitted per generated app, chosen by storage
 * layout. It reads and writes `up_users`/`up_roles` directly (through `StrapiRows`) and mints
 * the same HS256 JWT shape Strapi's users-permissions plugin issues, so a session minted by
 * either backend authenticates on both.
 */
export const emitStorageAuthController = (defaultRole: string | undefined): string => {
  const roleType = defaultRole ?? STRAPI_DEFAULT_ROLE;
  const role = phpSingleQuoted(roleType);
  const missingRole = phpSingleQuoted(
    `up_roles has no row with type '${roleType}'; boot Strapi against this database first`,
  );

  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Models\\UpRole;
use App\\Models\\User;
use App\\Support\\StrapiRows;
use Firebase\\JWT\\JWT;
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\DB;
use Illuminate\\Validation\\ValidationException;

/**
 * Strapi users-permissions–shaped auth over the shared \`up_users\` table. Unlike the Sanctum
 * layout's AuthController, this one issues the JWT Strapi itself would issue (see session())
 * and enforces uniqueness in code rather than in a database index, exactly as Strapi does.
 *
 * The password column is shared with Strapi, so bcrypt is used directly rather than through the
 * configured hash driver: Strapi hashes with bcryptjs, whose \`$2a$\` prefix Laravel's BcryptHasher
 * rejects outright, and a non-bcrypt HASH_DRIVER here would write a hash Strapi cannot read.
 */
class AuthController extends Controller
{
    public function register(Request $request): JsonResponse
    {
        $data = $request->validate([
            'username' => ['required', 'string', 'min:3'],
            'email' => ['required', 'email'],
            'password' => ['required', 'string', 'min:6'],
        ]);
        $username = $data['username'];
        $email = strtolower($data['email']);

        if (User::query()->where('email', $email)->orWhere('username', $username)->exists()) {
            throw ValidationException::withMessages(['email' => 'Email or Username are already taken']);
        }

        // Must stay PASSWORD_BCRYPT (never a driver-selected algorithm): Strapi's bcryptjs can
        // only verify a bcrypt hash, whatever cost it was written at.
        $user = new User([
            'username' => $username,
            'email' => $email,
            'password' => password_hash($data['password'], PASSWORD_BCRYPT, [
                'cost' => (int) config('hashing.bcrypt.rounds', 10),
            ]),
        ]);
        $user->provider = 'local';
        $user->confirmed = ! config('camis.email_confirmation');
        $user->blocked = false;

        // One transaction, role lookup first: an absent up_roles row must fail before the user row
        // is written. Committing the insert without the link would leave an account that logs in
        // but holds no role — every policy denies it — while burning the identifier, since the
        // uniqueness check above would reject the retry.
        DB::transaction(function () use ($user): void {
            $role = UpRole::query()->where('type', ${role})->first();
            if ($role === null) {
                // A configuration error, not a missing resource: StrapiErrors renders it as a 500.
                throw new \\RuntimeException(
                    ${missingRole},
                );
            }
            StrapiRows::create($user);
            StrapiRows::link($user, 'up_users_role_lnk', 'user_id', 'role_id', $role->id, 'user_ord');
        });

        return response()->json($this->session($user));
    }

    public function login(Request $request): JsonResponse
    {
        $data = $request->validate([
            'identifier' => ['required', 'string'],
            'password' => ['required', 'string'],
        ]);
        $identifier = $data['identifier'];
        $user = User::query()->where('provider', 'local')->where('email', strtolower($identifier))->first()
            ?? User::query()->where('provider', 'local')->where('username', $identifier)->first();
        if ($user === null || ! password_verify($data['password'], (string) $user->password)) {
            throw ValidationException::withMessages(['identifier' => 'Invalid identifier or password']);
        }
        if (config('camis.email_confirmation') && ! $user->confirmed) {
            throw ValidationException::withMessages(['identifier' => 'Your account email is not confirmed']);
        }
        if ($user->blocked) {
            throw ValidationException::withMessages([
                'identifier' => 'Your account has been blocked by an administrator',
            ]);
        }

        return response()->json($this->session($user));
    }

    public function me(Request $request): JsonResponse
    {
        $user = $request->user();

        return response()->json(${strapiUser});
    }

    private function session(User $user): array
    {
        // firebase/php-jwt refuses an HMAC key under 32 bytes, while Strapi signs with any length.
        // Left to JWT::encode, a short or unset secret surfaces as a blanket 401 on every
        // authenticated request, indistinguishable from a bad token.
        $secret = (string) config('camis.jwt_secret');
        if (strlen($secret) < 32) {
            throw new \\RuntimeException('camis.jwt_secret must be set (>= 32 bytes) — see DEPLOY.md');
        }
        $now = time();

        return [
            'jwt' => JWT::encode(
                ['id' => $user->id, 'iat' => $now, 'exp' => $now + 30 * 86400],
                $secret,
                'HS256',
            ),
            'user' => ${strapiUser},
        ];
    }
}
`;
};
