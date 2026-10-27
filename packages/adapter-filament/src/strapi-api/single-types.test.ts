import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi 5's single types: one entry, served at the type's singular name with find, update (which
// makes the entry the first time) and delete. single-type-vectors.json, recorded from strapi-php,
// is the behaviour.
describe("single types", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("serves a single type at its singular name, with no collection routes", () => {
    const routes = content("routes/api.php");
    const c = "HomepageApiController::class";
    expect(routes).toContain(`Route::get('/homepage', [${c}, 'single']);`);
    expect(routes).toContain(`Route::put('/homepage', [${c}, 'putSingle']);`);
    expect(routes).toContain(`Route::delete('/homepage', [${c}, 'destroySingle']);`);
    expect(routes).not.toContain("'/homepages'");
    expect(routes).not.toContain(`[${c}, 'index']`);
  });

  it("finds, makes or updates, and deletes the one entry", () => {
    const controller = content("app/Http/Controllers/Api/Generated/HomepageApiController.php");
    expect(controller).toContain("public function single(Request $request): JsonResponse");
    expect(controller).toContain("public function putSingle(Request $request): JsonResponse");
    expect(controller).toContain("public function destroySingle(Request $request): JsonResponse");
    expect(controller).toContain(
      "throw new StrapiError(400, 'ValidationError', 'Missing \"data\" payload in the request body');",
    );
    // Strapi's update grant makes the entry: a single type has no create action.
    expect(controller).toContain("$this->authorize('update', $m);");
    expect(controller).not.toContain("$this->authorize('create', Homepage::class);");
    const book = content("app/Http/Controllers/Api/Generated/BookApiController.php");
    expect(book).not.toContain("function single(");
  });

  it("names a single type's token actions find, update and delete", () => {
    const tokens = content("app/Support/StrapiApiTokens.php");
    expect(tokens).toContain(
      "'single' => 'find', 'putSingle' => 'update', 'destroySingle' => 'delete'",
    );
    expect(tokens).toContain(
      "private const SINGLE_TYPES = ['api::global.global', 'api::homepage.homepage'];",
    );
  });

  it("no longer reports that the REST API serves a single type as a collection", () => {
    const graphql = filamentAdapter.generate(strapiApiBundle, {
      projectName: "oyl",
      apiStyle: "strapi",
      graphql: true,
    });
    const gap = graphql.gaps.gaps.find(
      (g) => g.feature === "graphqlSingleTypes" && g.location.contentType === "Homepage",
    );
    expect(gap?.message).toBe('"Homepage" is a single type; GraphQL serves it as a collection.');
  });
});
