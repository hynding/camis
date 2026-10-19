import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// The IR's `public` role is what a caller without a session may do, as Strapi's public role is.
describe("the public role on the Strapi API style", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("lets a policy answer for a caller without a session from the public role's grants", () => {
    const policy = content("app/Policies/BookPolicy.php");
    expect(policy).toContain("public function viewAny(?User $user): bool");
    expect(policy).toContain("return PublicRole::allows($user, 'book.read');");
    expect(policy).toContain("public function create(?User $user): bool");
  });

  it("evaluates a condition for a guest without any user value but the role", () => {
    const policy = content("app/Policies/ActivityPolicy.php");
    expect(policy).toContain("public function view(?User $user, Activity $record): bool");
    expect(policy).toContain("$user === null ? ['user.role' => 'public'] : [");
  });

  it("reads the public role's grants from the permission cache, not per request", () => {
    const role = content("app/Support/PublicRole.php");
    expect(role).toContain("PermissionRegistrar::class");
    expect(role).toContain("contains('name', 'public')");
  });

  it("scopes a guest's list without the user's own rows", () => {
    const model = content("app/Models/Activity.php");
    expect(model).toContain("public function scopeForUser(Builder $q, ?User $user): Builder");
    expect(model).toContain("if ($user === null) {");
    expect(model).toContain("$q->where('visibility', '=', 'public');");
  });

  it("scopes a guest out of a type whose only read condition names the user", () => {
    expect(content("app/Models/Note.php")).toContain("$q->whereRaw('1 = 0');");
  });

  it("authorizes through the gate, which knows a guest, rather than through the user", () => {
    const controller = content("app/Http/Controllers/Api/Generated/BookApiController.php");
    expect(controller).toContain("Gate::allows('view', $m)");
    expect(controller).not.toContain("$request->user()->can(");
    expect(content("app/Http/Controllers/Api/Generated/NoteApiController.php")).toContain(
      "$m->owner_id = $request->user()?->id;",
    );
  });

  it("checks relations for a guest too: null is a caller, not an unsecured project", () => {
    const query = content("app/Support/StrapiQuery.php");
    expect(query).not.toContain("$viewer === null ||");
    expect(query).toContain("Gate::forUser($viewer)->allows('viewAny', $relation['model'])");
  });

  it("serves content to a caller without a session, and still refuses a bad token", () => {
    const routes = content("routes/api.php");
    expect(routes).toContain(
      "Route::middleware([StrapiCredentials::class.':optional', StrapiActiveUser::class])->group(",
    );
    expect(routes).toContain("Route::get('/books', [BookApiController::class, 'index']);");
    expect(content("app/Http/Middleware/StrapiCredentials.php")).toContain(
      "throw new StrapiError(401, 'UnauthorizedError', 'Missing or invalid credentials');",
    );
  });

  it("refuses a session on the routes only the public role holds, as Strapi does", () => {
    const routes = content("routes/api.php");
    expect(routes).toContain(
      "Route::post('/auth/local', [AuthController::class, 'login'])->middleware([$authThrottle, StrapiCredentials::class.':guest']);",
    );
    expect(routes).toContain(
      "Route::post('/auth/forgot-password', [AuthController::class, 'forgotPassword'])->middleware([$authThrottle, StrapiCredentials::class.':guest']);",
    );
  });

  it("lets the user list follow the public role as well", () => {
    expect(content("app/Http/Controllers/Api/UserController.php")).toContain(
      "PublicRole::allows($request->user(), $permission)",
    );
  });

  it("reports no gap: the laravel storage layout honours the public role", () => {
    expect(result.gaps.gaps).toEqual([]);
  });
});

describe("the public role elsewhere", () => {
  it("reports the Laravel API style, which requires a session on every route", () => {
    const result = filamentAdapter.generate(strapiApiBundle, { projectName: "oyl" });
    expect(result.gaps.gaps.map((g) => g.feature)).toContain("publicRole");
  });

  it("leaves a project without a public role's policies requiring a user", () => {
    const withoutPublic = {
      ...strapiApiBundle,
      roles: strapiApiBundle.roles.filter((r) => r.name !== "public"),
    };
    const result = filamentAdapter.generate(withoutPublic, {
      projectName: "oyl",
      apiStyle: "strapi",
    });
    const policies = result.files.filter((f) => f.path.startsWith("app/Policies/"));
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) expect(policy.content).not.toContain("?User");
    expect(result.files.some((f) => f.path === "app/Support/PublicRole.php")).toBe(false);
  });
});
