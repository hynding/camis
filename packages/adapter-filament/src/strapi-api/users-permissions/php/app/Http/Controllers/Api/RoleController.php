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
use App\Support\StrapiServices;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Spatie\Permission\Models\Role;

/**
 * Strapi's roles and permissions routes: read by an API token holding their actions, or by a
 * caller whose role holds the roles.read service. A role's grants are the IR's, rebuilt on every
 * build, so no write is taken.
 */
final class RoleController extends Controller
{
    public function find(): JsonResponse
    {
        self::readable();
        $roles = self::roles()->get();
        $users = self::users($roles->modelKeys());
        $roles = $roles->map(fn (Role $role): array => [...RoleSerializer::toWire($role), 'nb_users' => $users[$role->getKey()] ?? 0]);

        return response()->json(['roles' => $roles->values()->all()]);
    }

    public function findOne(string $role): JsonResponse
    {
        self::readable();
        $found = ctype_digit($role) ? self::roles()->with('permissions')->whereKey((int) $role)->first() : null;
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

    /** A token holding the actions, already checked by StrapiApiToken, or a role holding the service. */
    private static function readable(): void
    {
        StrapiServices::authorize(request(), 'roles.read');
    }

    /** @return Builder<Role> The users' roles: the admin's own are apart, as in Strapi. */
    private static function roles(): Builder
    {
        $admin = class_exists(AdminUser::class) ? AdminUser::adminRoles() : [];

        return Role::query()->whereNotIn('name', $admin)->orderBy('id');
    }

    /**
     * @param list<int|string> $roleIds
     * @return array<int|string, int> Each role's number of users.
     */
    private static function users(array $roleIds): array
    {
        return DB::table(config('permission.table_names.model_has_roles', 'model_has_roles'))
            ->whereIn('role_id', $roleIds)->where('model_type', User::class)
            ->groupBy('role_id')->selectRaw('role_id, count(*) as users')->pluck('users', 'role_id')
            ->map(fn (mixed $count): int => (int) $count)->all();
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
        // An app without roles keeps no tokens, so it lists no action.
        foreach (class_exists(StrapiApiTokens::class) ? array_keys(StrapiApiTokens::actions()) : [] as $action) {
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
