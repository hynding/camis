import { PHP_MARKER } from "../hooks/names";

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

const strapiUser = "['id' => $user->id, 'username' => $user->username, 'email' => $user->email]";

// Wrap an author-controlled string as a single-quoted PHP literal, escaping backslashes and single
// quotes so it cannot break out of (or inject code into) the generated PHP.
const phpSingleQuoted = (s: string): string => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export const emitAuthController = (defaultRole: string | undefined): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Models\\User;
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\Request;
use Illuminate\\Support\\Facades\\Hash;
use Illuminate\\Validation\\ValidationException;

/** Strapi users-permissions–shaped auth over Sanctum personal access tokens. */
class AuthController extends Controller
{
    private const TOKEN_NAME = 'api';

    public function register(Request $request): JsonResponse
    {
        $data = $request->validate([
            'username' => ['required', 'string', 'min:3', 'unique:users,username'],
            'email' => ['required', 'email', 'unique:users,email'],
            'password' => ['required', 'string', 'min:6'],
        ]);
        $user = new User([
            'name' => $data['username'],
            'email' => $data['email'],
            'password' => Hash::make($data['password']),
        ]);
        $user->username = $data['username'];
        $user->save();
${defaultRole !== undefined ? `        $user->assignRole(${phpSingleQuoted(defaultRole)});\n` : ""}
        return response()->json($this->session($user));
    }

    public function login(Request $request): JsonResponse
    {
        $data = $request->validate([
            'identifier' => ['required', 'string'],
            'password' => ['required', 'string'],
        ]);
        $user = User::query()->where('email', $data['identifier'])->first()
            ?? User::query()->where('username', $data['identifier'])->first();
        if ($user === null || ! Hash::check($data['password'], $user->password)) {
            throw ValidationException::withMessages(['identifier' => 'Invalid identifier or password']);
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
        return [
            'jwt' => $user->createToken(self::TOKEN_NAME)->plainTextToken,
            'user' => ${strapiUser},
        ];
    }
}
`;
