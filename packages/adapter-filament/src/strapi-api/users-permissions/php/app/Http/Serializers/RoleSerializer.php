<?php

declare(strict_types=1);

namespace App\Http\Serializers;

use App\Support\StrapiRoles;
use Spatie\Permission\Models\Role;

final class RoleSerializer
{
    /** Wire path → column, for StrapiQuery's filters, sort and fields. */
    public const FIELDS = [
        'id' => ['column' => 'id', 'type' => 'integer'],
        // The role's type names it for good; Strapi's documentId is a random one.
        'documentId' => ['column' => 'name', 'type' => 'string'],
        'name' => ['column' => 'name', 'type' => 'string'],
        'description' => ['column' => 'name', 'type' => 'string'],
        'type' => ['column' => 'name', 'type' => 'string'],
        'createdAt' => ['column' => 'created_at', 'type' => 'dateTime'],
        'updatedAt' => ['column' => 'updated_at', 'type' => 'dateTime'],
        'publishedAt' => ['column' => 'created_at', 'type' => 'dateTime'],
    ];

    public const COMPONENTS = [];

    public const ZONES = [];

    public const DRAFT_PUBLISH = false;

    public const LOCALIZED = false;

    public static function toWire(Role $m): array
    {
        return [
            'id' => $m->getKey(),
            'documentId' => $m->name,
            'name' => ucfirst($m->name),
            'description' => StrapiRoles::description($m),
            'type' => $m->name,
            'createdAt' => $m->created_at?->toIso8601ZuluString('millisecond'),
            'updatedAt' => $m->updated_at?->toIso8601ZuluString('millisecond'),
            'publishedAt' => $m->created_at?->toIso8601ZuluString('millisecond'),
        ];
    }
}
