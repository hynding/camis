<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Serializers\RoleSerializer;
use App\Models\AdminUser;
use App\Models\User;
use App\Support\StrapiApiTokens;
use App\Support\StrapiError;
use App\Support\StrapiRoles;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Spatie\Permission\Models\Role;

/**
 * Strapi's roles and permissions routes. No IR grant names their actions, so only an API token
 * holding them (full access, or read-only for the reads) gets past StrapiApiToken to read them.
 * A role's grants are the IR's, rebuilt on every build, so no write is taken.
 */
final class RoleController extends Controller
{
    public function find(): JsonResponse
    {
        self::readable();
        $roles = self::roles()->map(fn (Role $role): array => [...RoleSerializer::toWire($role), 'nb_users' => self::users($role)]);

        return response()->json(['roles' => $roles->values()->all()]);
    }

    public function findOne(string $role): JsonResponse
    {
        self::readable();
        $found = self::roles()->first(fn (Role $candidate): bool => (string) $candidate->getKey() === $role);
        if ($found === null) {
            throw new StrapiError(404, 'NotFoundError', 'Not Found');
        }

        return response()->json(['role' => [...RoleSerializer::toWire($found), 'permissions' => self::permissions($found)]]);
    }

    public function getPermissions(): JsonResponse
    {
        self::readable();

        return response()->json(['permissions' => self::permissions(null)]);
    }

    public function createRole(): never
    {
        throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
    }

    public function updateRole(): never
    {
        throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
    }

    public function deleteRole(): never
    {
        throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
    }

    /** A user's session never holds these actions: only a token StrapiApiToken let through does. */
    private static function readable(): void
    {
        if (! class_exists(StrapiApiTokens::class) || ! StrapiApiTokens::active()) {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }
    }

    /** @return \Illuminate\Support\Collection<int, Role> The users' roles: the admin's own are apart, as in Strapi. */
    private static function roles(): \Illuminate\Support\Collection
    {
        $admin = class_exists(AdminUser::class) ? AdminUser::adminRoles() : [];

        return Role::query()->with('permissions')->whereNotIn('name', $admin)->orderBy('id')->get();
    }

    private static function users(Role $role): int
    {
        return DB::table(config('permission.table_names.model_has_roles', 'model_has_roles'))
            ->where('role_id', $role->getKey())->where('model_type', User::class)->count();
    }

    /**
     * Strapi's tree of every content API action, `{ <api or plugin>: { controllers: { <controller>:
     * { <action>: { enabled, policy } } } } }`, enabled where the role holds it.
     *
     * @return array<string, array{controllers: array<string, array<string, array{enabled: bool, policy: string}>>}>
     */
    private static function permissions(?Role $role): array
    {
        $tree = [];
        foreach (array_keys(StrapiApiTokens::actions()) as $action) {
            $at = (int) strrpos($action, '.');
            $owner = substr($action, 0, $at);
            [$prefix, $controller] = explode('.', $owner, 2) + [1 => ''];
            $tree[$prefix]['controllers'][$controller][substr($action, $at + 1)] = [
                'enabled' => $role !== null && self::holds($role, $owner, substr($action, $at + 1)),
                'policy' => '',
            ];
        }

        return $tree;
    }

    private static function holds(Role $role, string $uid, string $action): bool
    {
        return class_exists(StrapiRoles::class) && in_array($action, StrapiRoles::held($role, $uid), true);
    }
}
