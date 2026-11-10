<?php

declare(strict_types=1);

namespace App\Http\Serializers;

use App\Support\StrapiRoles;
use App\Support\StrapiUsers;
use Spatie\Permission\Models\Role;

final class RoleSerializer
{
    /** Wire path → column, for StrapiQuery's filters, sort and fields. */
    public const FIELDS = [
        'id' => ['column' => 'id', 'type' => 'integer'],
        'documentId' => ['column' => 'document_id', 'type' => 'string'],
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
            'documentId' => self::documentId($m),
            'name' => ucfirst($m->name),
            'description' => StrapiRoles::description($m),
            'type' => $m->name,
            'createdAt' => $m->created_at?->toIso8601ZuluString('millisecond'),
            'updatedAt' => $m->updated_at?->toIso8601ZuluString('millisecond'),
            'publishedAt' => $m->created_at?->toIso8601ZuluString('millisecond'),
        ];
    }

    /** The one a Strapi archive gave the role, else one made the first time the role is read. */
    public static function documentId(Role $m): string
    {
        if ((string) $m->getAttribute('document_id') === '') {
            $m->forceFill(['document_id' => StrapiUsers::newDocumentId()])->saveQuietly();
        }

        return (string) $m->getAttribute('document_id');
    }
}
