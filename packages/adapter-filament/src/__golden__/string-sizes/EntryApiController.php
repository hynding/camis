<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Entry;
use Illuminate\Foundation\Auth\Access\AuthorizesRequests;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class EntryApiController extends Controller
{
    use AuthorizesRequests;

    private const FIELDS = ['title', 'code', 'headline', 'abstract', 'contact', 'slug', 'handle', 'unbounded', 'label', 'tagline', 'summary', 'reply', 'key'];

    /** Each bounded field's rule: Laravel's max counts a string's characters, as mb_strlen does. */
    private const RULES = ['code' => ['max:40'], 'headline' => ['max:1000'], 'abstract' => ['max:20000'], 'contact' => ['max:320'], 'slug' => ['max:300'], 'handle' => ['max:673'], 'unbounded' => ['max:1073741824'], 'label' => ['max:100'], 'tagline' => ['max:500'], 'reply' => ['max:100'], 'key' => ['max:100']];

    public function index(): JsonResponse
    {
        $this->authorize('viewAny', Entry::class);
        return response()->json(Entry::query()->paginate(50));
    }

    public function show(Entry $entry): JsonResponse
    {
        $this->authorize('view', $entry);
        return response()->json($entry);
    }

    public function store(Request $request): JsonResponse
    {
        $this->authorize('create', Entry::class);
        $request->validate(self::RULES);
        $payload = $request->only(self::FIELDS);

        return response()->json(Entry::create($payload), 201);
    }

    public function update(Request $request, Entry $entry): JsonResponse
    {
        $this->authorize('update', $entry);
        $request->validate(self::RULES);
        $entry->update($request->only(self::FIELDS));

        return response()->json($entry);
    }

    public function destroy(Entry $entry): JsonResponse
    {
        $this->authorize('delete', $entry);
        $entry->delete();

        return response()->json(null, 204);
    }
}
