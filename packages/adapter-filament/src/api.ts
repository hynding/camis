import type { GeneratedFile } from "@camis/adapter-kernel";
import type { ContentType } from "@camis/ir-schema";
import { filamentNames, snake, snakeColumn } from "./names";

export interface ApiOptions {
  secured: boolean;
}

// Laravel's apiResource wildcard: singular snake of the resource name, so the
// route-model-bound parameter must use the same name for implicit binding.
const wildcard = (ct: ContentType): string => snake(ct.name);

export const emitApiController = (
  ct: ContentType,
  columns: string[],
  options: ApiOptions,
): string => {
  const model = filamentNames(ct).model;
  const param = wildcard(ct);
  const fields = columns.map((c) => `'${c}'`).join(", ");
  const upsertBy = ct.options?.upsertBy;
  const auth = (line: string): string => (options.secured ? `        ${line}\n` : "");

  const storeBody = upsertBy
    ? (() => {
        const col = snakeColumn(upsertBy);
        return `        $payload = $request->only(self::FIELDS);
        $${param} = ${model}::updateOrCreate(['${col}' => $payload['${col}'] ?? null], $payload);

        return response()->json($${param}, $${param}->wasRecentlyCreated ? 201 : 200);`;
      })()
    : `        $payload = $request->only(self::FIELDS);

        return response()->json(${model}::create($payload), 201);`;

  return `<?php

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Models\\${model};
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\Request;

class ${model}ApiController extends Controller
{
    private const FIELDS = [${fields}];

    public function index(): JsonResponse
    {
${auth(`$this->authorize('viewAny', ${model}::class);`)}        return response()->json(${model}::query()->paginate(50));
    }

    public function show(${model} $${param}): JsonResponse
    {
${auth(`$this->authorize('view', $${param});`)}        return response()->json($${param});
    }

    public function store(Request $request): JsonResponse
    {
${auth(`$this->authorize('create', ${model}::class);`)}${storeBody}
    }

    public function update(Request $request, ${model} $${param}): JsonResponse
    {
${auth(`$this->authorize('update', $${param});`)}        $${param}->update($request->only(self::FIELDS));

        return response()->json($${param});
    }

    public function destroy(${model} $${param}): JsonResponse
    {
${auth(`$this->authorize('delete', $${param});`)}        $${param}->delete();

        return response()->json(null, 204);
    }
}
`;
};

export const emitApiRoutes = (cts: ContentType[], options: ApiOptions): string => {
  const rows = [...cts]
    .sort((a, b) => filamentNames(a).table.localeCompare(filamentNames(b).table))
    .map((ct) => {
      const n = filamentNames(ct);
      return `    Route::apiResource('${n.table}', ${n.model}ApiController::class);`;
    })
    .join("\n");
  const uses = [...cts]
    .map((ct) => filamentNames(ct).model)
    .sort()
    .map((m) => `use App\\Http\\Controllers\\Api\\${m}ApiController;`)
    .join("\n");
  const group = options.secured
    ? `Route::middleware('auth')->group(function (): void {\n${rows}\n});`
    : `Route::group([], function (): void {\n${rows}\n});`;
  return `<?php

// @camis:generated — do not edit. Custom routes belong in routes/api-custom.php.

declare(strict_types=1);

${uses}
use Illuminate\\Support\\Facades\\Route;

${group}

require __DIR__.'/api-custom.php';
`;
};

// Protected seam: written once, never overwritten (mode: seed).
export const apiCustomSeed = (): GeneratedFile => ({
  path: "routes/api-custom.php",
  mode: "seed",
  content: `<?php

// Hand-written API routes. camis never overwrites this file.
// Example: an aggregate bootstrap endpoint.
//
// use Illuminate\\Support\\Facades\\Route;
//
// Route::middleware('auth')->get('/bootstrap', function () {
//     return response()->json([/* ... */]);
// });
`,
});
