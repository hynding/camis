<?php

declare(strict_types=1);

namespace App\Http\Controllers\Admin;

use App\Models\StrapiApiToken;
use App\Support\StrapiAdminAuth;
use App\Support\StrapiApiTokens;
use App\Support\StrapiError;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use InvalidArgumentException;

/**
 * Strapi's admin api-token routes (/admin/api-tokens), with its bodies: a client signed in at
 * /admin/login makes, reads, changes, regenerates and revokes content API tokens. Only an admin
 * who may change accounts may, as only such an admin may open the API Tokens page.
 */
final class StrapiAdminApiTokens
{
    public function list(Request $request): JsonResponse
    {
        $this->authorize($request);

        return response()->json(['data' => StrapiApiToken::query()->orderBy('id')->get()->map(fn (StrapiApiToken $token): array => self::serialize($token))->all()]);
    }

    public function create(Request $request): JsonResponse
    {
        $this->authorize($request);
        $attributes = $this->attributes($request);
        if (StrapiApiToken::query()->where('name', $attributes['name'])->exists()) {
            throw new StrapiError(400, 'ApplicationError', 'Name already taken');
        }
        try {
            $made = StrapiApiTokens::create($attributes);
        } catch (InvalidArgumentException $error) {
            throw new StrapiError(400, 'ValidationError', $error->getMessage());
        }

        return response()->json(['data' => [...self::serialize($made['token']), 'accessKey' => $made['accessKey']]], 201);
    }

    public function get(Request $request, int $id): JsonResponse
    {
        $this->authorize($request);

        return response()->json(['data' => self::serialize($this->find($id))]);
    }

    public function update(Request $request, int $id): JsonResponse
    {
        $this->authorize($request);
        $token = $this->find($id);
        $name = $request->input('name', $token->name);
        if (! is_string($name) || trim($name) === '') {
            throw new StrapiError(400, 'ValidationError', 'name is a required field');
        }
        if (StrapiApiToken::query()->where('name', trim($name))->whereKeyNot($token->id)->exists()) {
            throw new StrapiError(400, 'ApplicationError', 'Name already taken');
        }
        $type = $request->input('type', $token->type);
        if (! in_array($type, StrapiApiTokens::TYPES, true)) {
            throw new StrapiError(400, 'ValidationError', 'type must be one of the following values: ' . implode(', ', StrapiApiTokens::TYPES));
        }
        $permissions = $type === 'custom' ? self::permissions($request->input('permissions', $token->permissions ?? [])) : null;
        if ($type === 'custom' && $permissions === []) {
            throw new StrapiError(400, 'ValidationError', 'A custom API token needs at least one permission');
        }
        $description = $request->input('description', $token->description);
        $token->forceFill([
            'name' => trim($name),
            'description' => is_string($description) ? $description : '',
            'type' => $type,
            'permissions' => $permissions,
        ])->save();

        return response()->json(['data' => self::serialize($token)]);
    }

    public function revoke(Request $request, int $id): JsonResponse
    {
        $this->authorize($request);
        $token = $this->find($id);
        $token->delete();

        return response()->json(['data' => self::serialize($token)]);
    }

    public function regenerate(Request $request, int $id): JsonResponse
    {
        $this->authorize($request);
        $token = $this->find($id);

        return response()->json(['data' => ['id' => $token->id, 'accessKey' => StrapiApiTokens::regenerate($token)]], 201);
    }

    /** @return array<string, mixed> a token as Strapi's api-token service lists it, without its key */
    public static function serialize(StrapiApiToken $token): array
    {
        return [
            'id' => $token->id,
            'name' => $token->name,
            'description' => $token->description,
            'type' => $token->type,
            'lastUsedAt' => $token->last_used_at?->toISOString(),
            'expiresAt' => $token->expires_at?->toISOString(),
            'lifespan' => $token->lifespan,
            'createdAt' => $token->created_at?->toISOString(),
            'updatedAt' => $token->updated_at?->toISOString(),
            'permissions' => $token->permissions ?? [],
        ];
    }

    private function authorize(Request $request): void
    {
        $admin = StrapiAdminAuth::admin($request);
        if (! $admin->can('user.update')) {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }
    }

    private function find(int $id): StrapiApiToken
    {
        return StrapiApiToken::query()->find($id) ?? throw new StrapiError(404, 'NotFoundError', 'API Token not found');
    }

    /** @return array{name: string, description: string, type: string, lifespan: int|null, permissions: list<string>} */
    private function attributes(Request $request): array
    {
        $name = $request->input('name');
        if (! is_string($name) || trim($name) === '') {
            throw new StrapiError(400, 'ValidationError', 'name is a required field');
        }
        $type = $request->input('type');
        if (! is_string($type)) {
            throw new StrapiError(400, 'ValidationError', 'type is a required field');
        }
        $lifespan = $request->input('lifespan');
        $description = $request->input('description');

        return [
            'name' => trim($name),
            'description' => is_string($description) ? $description : '',
            'type' => $type,
            'lifespan' => is_numeric($lifespan) ? (int) $lifespan : null,
            'permissions' => self::permissions($request->input('permissions', [])),
        ];
    }

    /** @return list<string> */
    private static function permissions(mixed $permissions): array
    {
        return is_array($permissions) ? array_values(array_unique(array_filter($permissions, 'is_string'))) : [];
    }
}
