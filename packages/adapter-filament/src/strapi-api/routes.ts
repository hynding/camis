import type { ContentType } from "@camis/ir-schema";
import { filamentNames } from "../names";
import { routePath } from "./names";

export const emitStrapiRoutes = (cts: ContentType[], secured: boolean): string => {
  const sorted = [...cts].sort((a, b) => routePath(a).localeCompare(routePath(b)));
  const uses = [
    "App\\Http\\Controllers\\Api\\AuthController",
    ...sorted.map((ct) => `App\\Http\\Controllers\\Api\\${filamentNames(ct).model}ApiController`),
    "App\\Http\\Middleware\\StrapiErrors",
    "Illuminate\\Support\\Facades\\Route",
  ]
    .sort()
    .map((u) => `use ${u};`)
    .join("\n");
  const resources = sorted
    .map((ct) => {
      const p = routePath(ct);
      const c = `${filamentNames(ct).model}ApiController::class`;
      return `        Route::get('/${p}', [${c}, 'index']);
        Route::post('/${p}', [${c}, 'store']);
        Route::get('/${p}/{key}', [${c}, 'show']);
        Route::put('/${p}/{key}', [${c}, 'update']);
        Route::delete('/${p}/{key}', [${c}, 'destroy']);`;
    })
    .join("\n\n");
  const guard = secured ? "Route::middleware('auth:sanctum')" : "Route::middleware([])";
  return `<?php

// @camis:generated — do not edit. Custom routes belong in routes/api-custom.php.

declare(strict_types=1);

${uses}

Route::middleware([StrapiErrors::class])->group(function (): void {
    Route::get('/_health', fn () => response()->noContent());
    Route::post('/auth/local', [AuthController::class, 'login']);
    Route::post('/auth/local/register', [AuthController::class, 'register']);

    ${guard}->group(function (): void {
        Route::get('/users/me', [AuthController::class, 'me']);

${resources}
    });
});

require __DIR__.'/api-custom.php';
`;
};
