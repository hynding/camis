import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { routeHooksBundle } from "../__fixtures__/route-hooks";

const generate = (apiStyle: "laravel" | "strapi") =>
  filamentAdapter.generate(routeHooksBundle, { projectName: "blog", apiStyle });

describe("filament route policies and middlewares", () => {
  for (const apiStyle of ["laravel", "strapi"] as const) {
    const result = generate(apiStyle);
    const file = (p: string) => result.files.find((f) => f.path === p);

    it(`${apiStyle}: runs them from one middleware that knows each route's action`, async () => {
      await expect(file("app/Http/Middleware/CamisRouteHooks.php")!.content).toMatchFileSnapshot(
        `./__golden__/CamisRouteHooks.${apiStyle}.php`,
      );
    });

    // Strapi composes a route as authenticate, authorize, policies, middlewares, action: a caller
    // without the action's permission is refused as forbidden before any policy is asked.
    it(`${apiStyle}: checks the caller's permission for the action before the policies`, () => {
      const runtime = file("app/Http/Middleware/CamisRouteHooks.php")!.content;
      expect(runtime).toContain("'update' => 'updateAny',");
      expect(runtime).toContain("'model' => \\App\\Models\\Article::class,");
      const authorize = runtime.indexOf(
        "Gate::authorize(self::ABILITIES[$action], $hooks['model']);",
      );
      expect(authorize).toBeGreaterThan(0);
      expect(authorize).toBeLessThan(runtime.indexOf("->allows($request, $action)"));
    });

    it(`${apiStyle}: seeds a policy and a middleware against a generated contract`, async () => {
      expect(file("app/Hooks/IsOwner.php")!.mode).toBe("seed");
      expect(file("app/Hooks/AuditTrail.php")!.mode).toBe("seed");
      await expect(file("app/Hooks/IsOwner.php")!.content).toMatchFileSnapshot(
        "./__golden__/IsOwner.stub.php",
      );
      await expect(file("app/Hooks/Contracts/IsOwnerPolicy.php")!.content).toMatchFileSnapshot(
        "./__golden__/IsOwnerPolicy.php",
      );
      await expect(file("app/Hooks/AuditTrail.php")!.content).toMatchFileSnapshot(
        "./__golden__/AuditTrail.stub.php",
      );
      await expect(
        file("app/Hooks/Contracts/AuditTrailMiddleware.php")!.content,
      ).toMatchFileSnapshot("./__golden__/AuditTrailMiddleware.php");
    });
  }

  it("laravel: puts the middleware on the hooked types' resources only", () => {
    const routes = generate("laravel").files.find((f) => f.path === "routes/api.php")!.content;
    expect(routes).toContain("use App\\Http\\Middleware\\CamisRouteHooks;");
    expect(routes).toContain(
      "Route::apiResource('articles', ArticleApiController::class)->middleware(CamisRouteHooks::class);",
    );
    expect(routes).toContain("Route::apiResource('tags', TagApiController::class);");
  });

  it("strapi: puts the middleware on the hooked types' routes only", () => {
    const routes = generate("strapi").files.find((f) => f.path === "routes/api.php")!.content;
    expect(routes).toContain("use App\\Http\\Middleware\\CamisRouteHooks;");
    expect(routes).toContain(
      "Route::put('/articles/{key}', [ArticleApiController::class, 'update'])->middleware(CamisRouteHooks::class);",
    );
    expect(routes).toContain(
      "Route::get('/homepage', [HomepageApiController::class, 'single'])->middleware(CamisRouteHooks::class);",
    );
    expect(routes).toContain("Route::get('/tags', [TagApiController::class, 'index']);");
  });

  it("emits nothing for a project without them", () => {
    const plain = filamentAdapter.generate(
      {
        ...routeHooksBundle,
        document: { ...routeHooksBundle.document, policies: [], middlewares: [] },
      },
      { projectName: "blog", apiStyle: "strapi" },
    );
    expect(plain.files.some((f) => f.path.includes("CamisRouteHooks"))).toBe(false);
    expect(plain.files.find((f) => f.path === "routes/api.php")!.content).not.toContain(
      "CamisRouteHooks",
    );
  });
});
