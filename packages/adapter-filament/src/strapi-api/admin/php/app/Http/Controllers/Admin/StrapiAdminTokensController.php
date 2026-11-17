<?php

declare(strict_types=1);

namespace App\Http\Controllers\Admin;

use App\Models\AdminUser;
use App\Models\StrapiAdminToken;
use App\Support\StrapiAdminAuth;
use App\Support\StrapiAdminPermissions;
use App\Support\StrapiAdminTokens;
use App\Support\StrapiError;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use InvalidArgumentException;

/**
 * Strapi's admin-token routes (/admin/admin-tokens), with its bodies and errors: an admin makes
 * tokens that act as themselves, reads and changes their own (a super-admin, every one), and only
 * a token's owner sees its key or regenerates it. Only an admin who may change accounts may, as
 * only such an admin may open the API Tokens page.
 */
final class StrapiAdminTokensController
{
    public function list(Request $request): JsonResponse
    {
        $admin = $this->authorize($request);
        $tokens = StrapiAdminToken::query()->with('owner')
            ->when(! StrapiAdminTokens::isSuperAdmin($admin), fn ($query) => $query->where('admin_user_owner_id', $admin->id))
            ->orderBy('name')->get();

        return response()->json(['data' => $tokens->map(fn (StrapiAdminToken $token): array => self::serialize($token))->all()]);
    }

    public function create(Request $request): JsonResponse
    {
        $admin = $this->authorize($request);
        if ($request->has('type')) {
            throw new StrapiError(400, 'BadRequestError', 'Type is not allowed for admin tokens');
        }
        if ($request->has('permissions')) {
            throw new StrapiError(400, 'BadRequestError', 'Permissions are not allowed for admin tokens');
        }
        $name = self::name($request->input('name'));
        if (DB::table('strapi_api_tokens')->where('name', $name)->exists()) {
            throw new StrapiError(400, 'ApplicationError', 'Name already taken');
        }
        $lifespan = $request->input('lifespan');
        try {
            $made = StrapiAdminTokens::create($admin, [
                'name' => $name,
                'description' => self::description($request->input('description')),
                'lifespan' => is_numeric($lifespan) ? (int) $lifespan : null,
                'admin_permissions' => StrapiAdminPermissions::fromStrapi($request->input('adminPermissions', [])),
            ]);
        } catch (InvalidArgumentException $error) {
            throw new StrapiError(400, 'ValidationError', $error->getMessage());
        }

        return response()->json(['data' => [...self::serialize($made['token']), 'accessKey' => $made['accessKey']]], 201);
    }

    public function get(Request $request, int $id): JsonResponse
    {
        $admin = $this->authorize($request);
        $token = $this->find($id);
        if (! StrapiAdminTokens::manages($admin, $token)) {
            throw new StrapiError(404, 'NotFoundError', 'API Token not found');
        }
        $key = (int) $token->admin_user_owner_id === (int) $admin->id ? StrapiAdminTokens::reveal($token) : null;

        return response()->json(['data' => [...self::serialize($token), ...($key === null ? [] : ['accessKey' => $key])]]);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $admin = $this->authorize($request);
        if ($request->has('type')) {
            throw new StrapiError(400, 'BadRequestError', 'Type is not allowed for admin tokens');
        }
        if ($request->has('permissions')) {
            throw new StrapiError(400, 'BadRequestError', 'Permissions are not allowed for admin tokens');
        }
        $name = $request->has('name') ? self::name($request->input('name')) : null;
        $token = $this->find($id);
        if ($name !== null && DB::table('strapi_api_tokens')->where('name', $name)->where('id', '!=', $token->id)->exists()) {
            throw new StrapiError(400, 'ApplicationError', 'Name already taken');
        }
        if (! StrapiAdminTokens::manages($admin, $token)) {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }
        $changes = [];
        if ($name !== null) {
            $changes['name'] = $name;
        }
        if ($request->has('description')) {
            $changes['description'] = self::description($request->input('description'));
        }
        if ($request->has('adminPermissions')) {
            // The ceiling is the owner's, whoever makes the change.
            $owner = $token->owner ?? $admin;
            $changes['admin_permissions'] = StrapiAdminTokens::clamp($owner, StrapiAdminPermissions::fromStrapi($request->input('adminPermissions')));
        }
        $token->forceFill($changes)->save();

        return response()->json(['data' => self::serialize($token)]);
    }

    public function revoke(Request $request, int $id): JsonResponse
    {
        $admin = $this->authorize($request);
        $token = $this->find($id);
        if (! StrapiAdminTokens::manages($admin, $token)) {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }
        $token->delete();

        return response()->json(['data' => [...self::serialize($token), 'permissions' => []]]);
    }

    /** Only the owner regenerates: Strapi's super-admin does not bypass it. */
    public function regenerate(Request $request, int $id): JsonResponse
    {
        $admin = $this->authorize($request);
        $token = $this->find($id);
        if ((int) $token->admin_user_owner_id !== (int) $admin->id) {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }

        return response()->json(['data' => ['id' => $token->id, 'kind' => 'admin', 'name' => $token->name, 'accessKey' => StrapiAdminTokens::regenerate($token)]], 201);
    }

    /** What the token's owner holds: the most the token may be given. */
    public function ownerPermissions(Request $request, int $id): JsonResponse
    {
        $admin = $this->authorize($request);
        $token = $this->find($id, 'apiToken.notFound');
        if (! StrapiAdminTokens::manages($admin, $token)) {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }
        $owner = $token->owner ?? throw new StrapiError(404, 'NotFoundError', 'owner.notFound');

        return response()->json(['data' => StrapiAdminPermissions::toStrapi(StrapiAdminTokens::clamp($owner, array_keys(StrapiAdminPermissions::PERMISSIONS)))]);
    }

    /** @return array<string, mixed> a token as Strapi's api-token service lists an admin one, without its key */
    public static function serialize(StrapiAdminToken $token): array
    {
        $owner = $token->owner;

        return [
            'id' => $token->id,
            'kind' => 'admin',
            'name' => $token->name,
            'description' => $token->description,
            'lastUsedAt' => $token->last_used_at?->toISOString(),
            'type' => 'read-only',
            // A biginteger column, which Strapi reads back as a string.
            'lifespan' => $token->lifespan === null ? null : (string) $token->lifespan,
            'expiresAt' => $token->expires_at?->toISOString(),
            'createdAt' => $token->created_at?->toISOString(),
            'updatedAt' => $token->updated_at?->toISOString(),
            'adminPermissions' => StrapiAdminPermissions::toStrapi($token->admin_permissions ?? []),
            'adminUserOwner' => $owner instanceof AdminUser ? [
                'id' => $owner->id,
                'firstname' => $owner->firstname,
                'lastname' => $owner->lastname,
                'username' => $owner->username,
                'email' => $owner->email,
            ] : null,
        ];
    }

    private function authorize(Request $request): AdminUser
    {
        $admin = StrapiAdminAuth::admin($request);
        if (! $admin->can('user.update')) {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }

        return $admin;
    }

    private function find(int $id, string $message = 'API Token not found'): StrapiAdminToken
    {
        return StrapiAdminToken::query()->with('owner')->find($id) ?? throw new StrapiError(404, 'NotFoundError', $message);
    }

    /** Strapi's name check: trimmed, then at least one character, and present. */
    private static function name(mixed $value): string
    {
        $name = is_string($value) ? trim($value) : '';
        if ($name !== '') {
            return $name;
        }
        $error = fn (string $message): array => ['path' => ['name'], 'message' => $message, 'name' => 'ValidationError', 'value' => ''];

        throw new StrapiError(400, 'ValidationError', '2 errors occurred', ['errors' => [
            $error('name must be at least 1 characters'),
            $error('name is a required field'),
        ]]);
    }

    private static function description(mixed $value): string
    {
        return is_string($value) ? trim($value) : '';
    }
}
