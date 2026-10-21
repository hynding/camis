import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi 5's content API tokens (the admin's API Tokens settings and its `content-api-token` auth
// strategy); token-vectors.json, recorded from strapi-php, is the behaviour.
describe("API tokens", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("keeps each token's salted hash, never its key", () => {
    const migration = content(
      "database/migrations/0001_01_02_000005_create_strapi_api_tokens_table.php",
    );
    expect(migration).toContain("Schema::create('strapi_api_tokens'");
    expect(migration).toContain("$table->string('access_key', 128)->unique();");
    expect(migration).toContain("$table->json('permissions')->nullable();");
    const tokens = content("app/Support/StrapiApiTokens.php");
    expect(tokens).toContain("hash_hmac('sha512', $key, ");
    expect(tokens).toContain("bin2hex(random_bytes(128))");
  });

  it("scopes every route the way Strapi names its action", async () => {
    const tokens = content("app/Support/StrapiApiTokens.php");
    expect(tokens).toContain(
      "'App\\Http\\Controllers\\Api\\BookApiController' => 'api::book.book',",
    );
    expect(tokens).toContain("'login' => 'plugin::users-permissions.auth.callback',");
    expect(tokens).toContain("'find' => 'plugin::upload.content-api.find',");
    expect(tokens).toContain("'index' => 'plugin::i18n.locales.listLocales',");
    expect(tokens).toContain("\\App\\Models\\User::class => 'plugin::users-permissions.user',");
    await expect(tokens).toMatchFileSnapshot("./__golden__/strapi-api/StrapiApiTokens.php");
  });

  it("verifies a token as Strapi does: read-only reads, custom runs its actions", () => {
    const tokens = content("app/Support/StrapiApiTokens.php");
    expect(tokens).toContain(
      "'read-only' => $action !== null && (str_ends_with($action, '.find') || str_ends_with($action, '.findOne')),",
    );
    expect(tokens).toContain(
      "'custom' => $action !== null && in_array($action, $token->permissions ?? [], true),",
    );
    expect(tokens).toContain("throw new StrapiError(401, 'UnauthorizedError', 'Token expired');");
  });

  it("checks a token on every API route before its own credentials", async () => {
    const routes = content("routes/api.php");
    expect(routes).toContain("Route::pushMiddlewareToGroup('api', StrapiApiToken::class);");
    expect(routes).toContain(
      "Route::middleware([StrapiCredentials::class.':required', StrapiActiveUser::class])->group(",
    );
    expect(routes).not.toContain("'auth:sanctum'");
    const middleware = content("app/Http/Middleware/StrapiApiToken.php");
    expect(middleware).toContain("throw new StrapiError(403, 'ForbiddenError', 'Forbidden');");
    await expect(middleware).toMatchFileSnapshot("./__golden__/strapi-api/StrapiApiToken.php");
  });

  it("lets a token's request past the session checks, with no user", () => {
    const credentials = content("app/Http/Middleware/StrapiCredentials.php");
    expect(credentials).toContain(
      "if (StrapiApiTokens::active() || ($request->bearerToken() === null && $mode !== 'required')) {",
    );
    const users = content("app/Http/Controllers/Api/UserController.php");
    expect(users).toContain("throw new StrapiError(401, 'UnauthorizedError', 'Unauthorized');");
    const auth = content("app/Http/Controllers/Api/AuthController.php");
    const change = auth.slice(auth.indexOf("public function changePassword"));
    expect(change.indexOf("'You must be authenticated to reset your password'")).toBeLessThan(
      change.indexOf("StrapiUsers::validate("),
    );
    const sessions = content("app/Http/Controllers/Api/SessionController.php");
    expect(sessions).toContain(
      "throw new StrapiError(401, 'UnauthorizedError', 'Missing authentication');",
    );
  });

  it("reads every row through a token: a list scope does not narrow it", () => {
    const note = content("app/Models/Note.php");
    expect(note).toContain("public function scopeForUser(Builder $q, ?User $user): Builder");
    expect(note).toContain("if (\\App\\Support\\StrapiApiTokens::active()) {");
  });

  it("manages tokens on the admin's API Tokens page", () => {
    const resource = content("app/Filament/Resources/ApiTokens/ApiTokenResource.php");
    expect(resource).toContain("CheckboxList::make('permissions')");
    expect(resource).toContain("->options(StrapiApiTokens::actions())");
    const create = content("app/Filament/Resources/ApiTokens/Pages/CreateApiToken.php");
    expect(create).toContain("StrapiApiTokens::create($data)");
    const edit = content("app/Filament/Resources/ApiTokens/Pages/EditApiToken.php");
    expect(edit).toContain("StrapiApiTokens::regenerate($this->record)");
  });

  it("reads its salt from Strapi's API_TOKEN_SALT", () => {
    expect(content("config/camis.php")).toContain("'salt' => env('API_TOKEN_SALT'),");
  });

  it("reports the roles routes no token opens, since roles live in the IR", () => {
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        feature: "apiTokenRoles",
        message:
          "an API token is refused /users-permissions/roles and /permissions: the roles are the IR's, not data a token could read or change",
      }),
    );
  });
});
