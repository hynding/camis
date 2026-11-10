<?php

declare(strict_types=1);

namespace App\Http\Controllers\Admin;

use App\Models\AdminUser;
use App\Support\StrapiAdminAuth;
use App\Support\StrapiError;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Spatie\Permission\Models\Role;

/**
 * The part of Strapi's admin API a client signs in through (admin::authentication and
 * admin::authenticated-user): /admin/init, /admin/login, /admin/register-admin and
 * /admin/users/me, with Strapi's bodies and errors. The admin itself is Filament's.
 */
final class StrapiAdminController
{
    public function init(): JsonResponse
    {
        return response()->json(['data' => [
            'uuid' => false,
            'hasAdmin' => AdminUser::query()->exists(),
            'menuLogo' => null,
            'authLogo' => null,
        ]]);
    }

    /** Strapi's local strategy: an unknown email and a wrong password read alike. */
    public function login(Request $request): JsonResponse
    {
        $email = $request->input('email');
        $password = $request->input('password');
        if (! is_string($email) || $email === '' || ! is_string($password) || $password === '') {
            throw new StrapiError(400, 'ApplicationError', 'Missing credentials');
        }
        $admin = AdminUser::query()->where('email', mb_strtolower($email))->first();
        $hash = $admin?->getAttribute('password');
        if ($admin === null || ! is_string($hash) || $hash === '' || ! Hash::check($password, $hash)) {
            throw new StrapiError(400, 'ApplicationError', 'Invalid credentials');
        }
        if (! $admin->is_active) {
            throw new StrapiError(400, 'ApplicationError', 'User not active');
        }
        if ($admin->blocked) {
            throw new StrapiError(400, 'ApplicationError', 'Your account has been blocked by an administrator');
        }

        return $this->session($admin);
    }

    /** The first admin account, holding the first admin role, while there is none. */
    public function registerAdmin(Request $request): JsonResponse
    {
        $input = $this->registration($request);
        $role = AdminUser::adminRoles()[0] ?? null;
        if ($role === null || Role::query()->where('name', $role)->doesntExist()) {
            throw new StrapiError(400, 'ApplicationError', "Cannot register the first admin because the super admin role doesn't exist.");
        }
        $admin = DB::transaction(function () use ($input, $role): AdminUser {
            if (AdminUser::query()->lockForUpdate()->exists()) {
                throw new StrapiError(400, 'ApplicationError', 'You cannot register a new super admin');
            }
            $admin = new AdminUser();
            $admin->forceFill([...$input, 'is_active' => true])->save();
            $admin->assignRole($role);

            return $admin;
        });

        return $this->session($admin);
    }

    public function me(Request $request): JsonResponse
    {
        return response()->json(['data' => self::serialize(StrapiAdminAuth::admin($request))]);
    }

    /** @return array<string, mixed> the admin account as Strapi's sanitizeUser leaves it */
    public static function serialize(AdminUser $admin): array
    {
        return [
            'id' => $admin->id,
            'documentId' => $admin->getAttribute('document_id'),
            'firstname' => $admin->firstname,
            'lastname' => $admin->lastname,
            'username' => $admin->username,
            'email' => $admin->email,
            'isActive' => $admin->is_active,
            'blocked' => $admin->blocked,
            'preferedLanguage' => $admin->getAttribute('prefered_language'),
            'createdAt' => $admin->created_at?->toISOString(),
            'updatedAt' => $admin->updated_at?->toISOString(),
            'roles' => $admin->roles->map(fn (Model $role): array => [
                'id' => $role->getKey(),
                'name' => $role->getAttribute('name'),
                'description' => '',
                'code' => $role->getAttribute('name'),
            ])->values()->all(),
        ];
    }

    private function session(AdminUser $admin): JsonResponse
    {
        $token = StrapiAdminAuth::issue($admin);

        return response()->json(['data' => [
            'token' => $token,
            'accessToken' => $token,
            'user' => self::serialize($admin->fresh() ?? $admin),
        ]]);
    }

    /**
     * Strapi's admin registration rules: an email, a first name, and a password of 8 to 72 bytes
     * with a lowercase letter, an uppercase letter and a number.
     *
     * @return array{email: string, firstname: string, lastname: string|null, password: string}
     */
    private function registration(Request $request): array
    {
        $email = $request->input('email');
        $firstname = $request->input('firstname');
        $lastname = $request->input('lastname');
        $password = $request->input('password');
        $errors = [];
        if (! is_string($email) || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            $errors[] = ['email', 'email must be a valid email'];
        }
        if (! is_string($firstname) || trim($firstname) === '') {
            $errors[] = ['firstname', 'firstname is a required field'];
        }
        if (! is_string($password) || strlen($password) < 8) {
            $errors[] = ['password', 'password must be at least 8 characters'];
        } elseif (strlen($password) > 72) {
            $errors[] = ['password', 'Password must be less than 73 bytes'];
        } elseif (preg_match('/[a-z]/', $password) !== 1) {
            $errors[] = ['password', 'password must contain at least one lowercase character'];
        } elseif (preg_match('/[A-Z]/', $password) !== 1) {
            $errors[] = ['password', 'password must contain at least one uppercase character'];
        } elseif (preg_match('/\d/', $password) !== 1) {
            $errors[] = ['password', 'password must contain at least one number'];
        }
        if ($errors !== []) {
            throw new StrapiError(400, 'ValidationError', count($errors) === 1 ? $errors[0][1] : count($errors) . ' errors occurred', [
                'errors' => array_map(fn (array $error): array => ['path' => [$error[0]], 'message' => $error[1], 'name' => 'ValidationError'], $errors),
            ]);
        }

        return [
            'email' => mb_strtolower((string) $email),
            'firstname' => (string) $firstname,
            'lastname' => is_string($lastname) && $lastname !== '' ? $lastname : null,
            'password' => (string) $password,
        ];
    }
}
