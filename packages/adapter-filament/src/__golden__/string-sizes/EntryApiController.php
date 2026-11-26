<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Entry;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class EntryApiController extends Controller
{
    private const FIELDS = ['title', 'code', 'headline', 'abstract', 'contact', 'slug', 'handle', 'unbounded'];

    /** Each bounded field's rule: Laravel's max counts a string's characters, as mb_strlen does. */
    private const RULES = ['code' => ['max:40'], 'headline' => ['max:1000'], 'abstract' => ['max:20000'], 'contact' => ['max:320'], 'slug' => ['max:300'], 'handle' => ['max:1000'], 'unbounded' => ['max:1073741824']];

    public function index(): JsonResponse
    {
        return response()->json(Entry::query()->paginate(50));
    }

    public function show(Entry $entry): JsonResponse
    {
        return response()->json($entry);
    }

    public function store(Request $request): JsonResponse
    {
        $request->validate(self::RULES);
        $payload = $request->only(self::FIELDS);

        return response()->json(Entry::create($payload), 201);
    }

    public function update(Request $request, Entry $entry): JsonResponse
    {
        $request->validate(self::RULES);
        $entry->update($request->only(self::FIELDS));

        return response()->json($entry);
    }

    public function destroy(Entry $entry): JsonResponse
    {
        $entry->delete();

        return response()->json(null, 204);
    }
}
