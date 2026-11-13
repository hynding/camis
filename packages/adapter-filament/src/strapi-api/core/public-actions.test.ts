import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "../../generate";
import { authorRoleBundle } from "../__fixtures__/author-role";

// Strapi's route `auth: false`: the action takes no credentials and asks no grant.
const generate = (apiStyle: "laravel" | "strapi", bundle: IrBundle = authorRoleBundle) =>
  filamentAdapter.generate(bundle, { projectName: "press", apiStyle });
const strapi = generate("strapi");
const file = (path: string): string => strapi.files.find((f) => f.path === path)!.content;

describe("filament public content API actions", () => {
  it("routes a type's public actions outside every credential check", () => {
    const routes = file("routes/api.php");
    const open = routes.indexOf("Route::middleware(StrapiPublicRoute::class)->group(");
    expect(open).toBeGreaterThan(-1);
    const group = routes.slice(open, routes.indexOf("});", open));
    expect(group).toContain("Route::get('/memos', [MemoApiController::class, 'index']);");
    expect(group).toContain("Route::get('/memos/{key}', [MemoApiController::class, 'show']);");
    expect(group).not.toContain("'store'");
    // Each route once: a public one is not in the credential group too.
    expect(routes.match(/\[MemoApiController::class, 'index'\]/g)).toHaveLength(1);
    expect(routes).toContain("Route::post('/memos', [MemoApiController::class, 'store']);");
    expect(routes).toContain("use App\\Http\\Middleware\\StrapiPublicRoute;");
  });

  it("answers every grant a public route asks, and marks the request for the token check", () => {
    const middleware = file("app/Http/Middleware/StrapiPublicRoute.php");
    expect(middleware).toContain("@camis:generated");
    expect(middleware).toContain("Gate::before(");
    expect(middleware).toContain("public static function opens(Request $request): bool");
    expect(file("app/Http/Middleware/StrapiApiToken.php")).toContain(
      "StrapiPublicRoute::opens($request)",
    );
  });

  it("holds a public route's list to no row condition", () => {
    expect(file("app/Models/Memo.php")).toContain("StrapiPublicRoute::active()");
  });

  it("reports no gap where it serves them", () => {
    expect(strapi.gaps.gaps.filter((g) => g.feature === "publicApiActions")).toEqual([]);
  });

  it("leaves a project without public actions as it was", () => {
    const closed = generate("strapi", {
      ...authorRoleBundle,
      document: {
        ...authorRoleBundle.document,
        contentTypes: authorRoleBundle.document.contentTypes.map((ct) => ({
          ...ct,
          options: { ...ct.options, publicApiActions: [] },
        })),
      },
    });
    const content = (p: string) => closed.files.find((f) => f.path === p)?.content;
    expect(content("routes/api.php")).not.toContain("StrapiPublicRoute");
    expect(content("app/Models/Memo.php")).not.toContain("StrapiPublicRoute");
  });

  it("laravel: reports them, as every route there needs a session", () => {
    expect(generate("laravel").gaps.gaps.filter((g) => g.feature === "publicApiActions")).toEqual([
      {
        feature: "publicApiActions",
        location: { contentType: "Memo" },
        severity: "downgrade",
        message:
          'Memo opens list and read to anyone, which only apiStyle "strapi" on the laravel storage layout serves; grant them to the public role instead',
      },
    ]);
  });
});
