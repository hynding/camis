<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Locale;
use Illuminate\Http\JsonResponse;

class LocaleController extends Controller
{
    public function index(): JsonResponse
    {
        return response()->json(Locale::query()->orderBy('id')->get()->map(fn (Locale $l): array => [
            'id' => $l->id,
            'documentId' => $l->document_id,
            'name' => $l->name,
            'code' => $l->code,
            'createdAt' => $l->created_at?->toIso8601ZuluString('millisecond'),
            'updatedAt' => $l->updated_at?->toIso8601ZuluString('millisecond'),
            // Strapi stamps publishedAt on locales, which have no draft.
            'publishedAt' => $l->created_at?->toIso8601ZuluString('millisecond'),
            'isDefault' => $l->is_default,
        ])->all());
    }
}
