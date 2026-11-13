import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "../../generate";
import { authorRoleBundle } from "../__fixtures__/author-role";

// IR endpoints: Strapi's custom routes, each answered by a hand-written handler.
const generate = (apiStyle: "laravel" | "strapi", bundle: IrBundle = authorRoleBundle) =>
  filamentAdapter.generate(bundle, { projectName: "press", apiStyle });
const strapi = generate("strapi");
const file = (path: string) => strapi.files.find((f) => f.path === path);

describe("filament endpoints", () => {
  it("routes an endpoint ahead of its type's routes, a public one with the open routes", () => {
    const routes = file("routes/api.php")!.content;
    const pin =
      "Route::post('/memos/{id}/pin', CamisEndpoints::class)->defaults('endpoint', 'MemoPin');";
    const count =
      "Route::get('/memos/count', CamisEndpoints::class)->defaults('endpoint', 'MemoCount');";
    expect(routes).toContain(pin);
    expect(routes.indexOf(pin)).toBeLessThan(routes.indexOf("[MemoApiController::class, 'store']"));
    const open = routes.indexOf("Route::middleware(StrapiPublicRoute::class)->group(");
    expect(routes.indexOf(count)).toBeGreaterThan(open);
    expect(routes.indexOf(count)).toBeLessThan(
      routes.indexOf("[MemoApiController::class, 'index']"),
    );
    expect(routes).toContain("use App\\Http\\Controllers\\Api\\CamisEndpoints;");
  });

  it("seeds each handler once against a contract it keeps", async () => {
    const contract = file("app/Hooks/Contracts/MemoPinEndpoint.php")!;
    expect(contract.mode).toBeUndefined();
    await expect(contract.content).toMatchFileSnapshot("./__golden__/MemoPinEndpoint.php");
    const stub = file("app/Hooks/MemoPin.php")!;
    expect(stub.mode).toBe("seed");
    await expect(stub.content).toMatchFileSnapshot("./__golden__/MemoPin.php");
  });

  it("lets only the roles that list an endpoint call it, and anyone a public one", async () => {
    await expect(file("app/Http/Controllers/Api/CamisEndpoints.php")!.content).toMatchFileSnapshot(
      "./__golden__/CamisEndpoints.php",
    );
  });

  it("reports no gap where it serves them, and leaves a project without them as it was", () => {
    expect(strapi.gaps.gaps.filter((g) => g.feature === "endpoint")).toEqual([]);
    const none = generate("strapi", {
      ...authorRoleBundle,
      document: { ...authorRoleBundle.document, endpoints: [] },
      roles: authorRoleBundle.roles.map((r) => ({ ...r, endpoints: [] })),
    });
    expect(none.files.some((f) => f.path.includes("CamisEndpoints"))).toBe(false);
  });

  it("laravel: reports each endpoint, as only the Strapi API style serves them", () => {
    expect(generate("laravel").gaps.gaps.filter((g) => g.feature === "endpoint")).toEqual([
      {
        feature: "endpoint",
        location: { contentType: "Memo", rule: "MemoPin" },
        severity: "downgrade",
        message:
          'endpoint "MemoPin" (POST /memos/:id/pin) is served only by apiStyle "strapi" on the laravel storage layout; its route is not generated',
      },
      {
        feature: "endpoint",
        location: { contentType: "Memo", rule: "MemoCount" },
        severity: "downgrade",
        message:
          'endpoint "MemoCount" (GET /memos/count) is served only by apiStyle "strapi" on the laravel storage layout; its route is not generated',
      },
    ]);
  });
});
