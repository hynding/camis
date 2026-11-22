import type { GeneratedFile } from "@camis/adapter-kernel";
import type { DecimalDigits } from "@camis/ir-core";
import {
  ROUTE_ACTIONS,
  servesApiAction,
  type ContentType,
  type RouteAction,
} from "@camis/ir-schema";
import { filamentNames, snake, snakeColumn } from "./names";

export interface DecimalColumn extends DecimalDigits {
  column: string;
}

export interface ApiOptions {
  secured: boolean;
  /** The columns of decimals stating their digits, each written as its column keeps it. */
  decimals?: DecimalColumn[];
  /** Content types whose routes run the IR's route policies and middlewares. */
  hooked?: ReadonlySet<string>;
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
  const decimals = options.decimals ?? [];
  const payload =
    decimals.length === 0
      ? "$request->only(self::FIELDS)"
      : "self::withDecimals($request->only(self::FIELDS))";
  const auth = (line: string): string => (options.secured ? `        ${line}\n` : "");

  const storeBody = upsertBy
    ? (() => {
        const col = snakeColumn(upsertBy);
        return `        $payload = ${payload};
        $${param} = ${model}::updateOrCreate(['${col}' => $payload['${col}'] ?? null], $payload);

        return response()->json($${param}, $${param}->wasRecentlyCreated ? 201 : 200);`;
      })()
    : `        $payload = ${payload};

        return response()->json(${model}::create($payload), 201);`;

  return `<?php

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;
use App\\Models\\${model};${decimals.length === 0 ? "" : "\nuse App\\Support\\DecimalDigits;"}${
    options.secured ? "\nuse Illuminate\\Foundation\\Auth\\Access\\AuthorizesRequests;" : ""
  }
use Illuminate\\Http\\JsonResponse;
use Illuminate\\Http\\Request;${decimals.length === 0 ? "" : "\nuse Illuminate\\Validation\\ValidationException;"}

class ${model}ApiController extends Controller
{
${options.secured ? "    use AuthorizesRequests;\n\n" : ""}    private const FIELDS = [${fields}];
${decimalsConstant(decimals)}
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
${auth(`$this->authorize('update', $${param});`)}        $${param}->update(${payload});

        return response()->json($${param});
    }

    public function destroy(${model} $${param}): JsonResponse
    {
${auth(`$this->authorize('delete', $${param});`)}        $${param}->delete();

        return response()->json(null, 204);
    }${decimals.length === 0 ? "" : WITH_DECIMALS}
}
`;
};

const decimalsConstant = (decimals: DecimalColumn[]): string =>
  decimals.length === 0
    ? ""
    : `\n    /** Decimals stating their digits: each column's precision and scale. */\n    private const DECIMALS = [${decimals.map((d) => `'${d.column}' => [${d.precision}, ${d.scale}]`).join(", ")}];\n`;

// SQLite keeps a decimal beyond a PHP float as text, which takes any string: every value is kept
// as MySQL and PostgreSQL keep it, at its scale, and one that is not a decimal or does not fit is
// refused before it is written, with a 400 in Laravel's validation error shape.
const WITH_DECIMALS = `

    /** The payload with each decimal stating its digits as its column keeps it, from a string or a number. */
    private static function withDecimals(array $payload): array
    {
        foreach (self::DECIMALS as $column => [$precision, $scale]) {
            if (($payload[$column] ?? null) === null) {
                continue;
            }
            $decimal = DecimalDigits::canonical($payload[$column], $precision, $scale);
            if ($decimal === null) {
                throw ValidationException::withMessages([$column => "The {$column} field must be a decimal of at most {$precision} digits, {$scale} of them after the point."])->status(400);
            }
            $payload[$column] = $decimal;
        }

        return $payload;
    }`;

// The resource method serving each content API action.
const RESOURCE_METHODS: Record<RouteAction, string> = {
  list: "index",
  read: "show",
  create: "store",
  update: "update",
  delete: "destroy",
};

/** `->only(...)` the methods of the actions a type serves, when it lists them. */
const only = (ct: ContentType): string =>
  ct.options?.apiActions === undefined
    ? ""
    : `->only([${ROUTE_ACTIONS.filter((a) => servesApiAction(ct, a))
        .map((a) => `'${RESOURCE_METHODS[a]}'`)
        .join(", ")}])`;

export const emitApiRoutes = (cts: ContentType[], options: ApiOptions): string => {
  const rows = [...cts]
    .sort((a, b) => filamentNames(a).table.localeCompare(filamentNames(b).table))
    .map((ct) => {
      const n = filamentNames(ct);
      const hooks =
        options.hooked?.has(ct.name) === true ? "->middleware(CamisRouteHooks::class)" : "";
      return `    Route::apiResource('${n.table}', ${n.model}ApiController::class)${only(ct)}${hooks};`;
    })
    .join("\n");
  const uses = [...cts]
    .map((ct) => filamentNames(ct).model)
    .sort()
    .map((m) => `use App\\Http\\Controllers\\Api\\${m}ApiController;`)
    .concat((options.hooked?.size ?? 0) > 0 ? ["use App\\Http\\Middleware\\CamisRouteHooks;"] : [])
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
