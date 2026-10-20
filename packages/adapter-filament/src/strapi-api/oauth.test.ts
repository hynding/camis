import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

// Strapi 5's sign-in providers (users-permissions' "grant" settings and its OAuth connect flow);
// oauth-vectors.json, recorded from strapi-php against a stand-in provider, is the behaviour.
describe("users-permissions sign-in providers", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("knows Strapi's providers, their endpoints and their profile checks", async () => {
    const providers = content("app/Support/StrapiProviders.php");
    for (const name of [
      "email",
      "discord",
      "facebook",
      "google",
      "github",
      "microsoft",
      "twitter",
      "instagram",
      "vk",
      "twitch",
      "linkedin",
      "cognito",
      "reddit",
      "auth0",
      "cas",
      "patreon",
      "keycloak",
    ])
      expect(providers).toContain(`'${name}' => [`);
    expect(providers).toContain(
      "'authorize_url' => 'https://[subdomain]/protocol/openid-connect/auth',",
    );
    expect(providers).toContain("'Email not verified by Keycloak'");
    expect(providers).toContain("'Register action is actually not available.'");
    expect(providers).toContain("'Email is already taken.'");
    await expect(providers).toMatchFileSnapshot("./__golden__/strapi-api/StrapiProviders.php");
  });

  it("keeps a provider's settings where the admin edits them, over Strapi's defaults", () => {
    const providers = content("app/Support/StrapiProviders.php");
    expect(providers).toContain("StrapiSettings::get('users-permissions.grant'");
  });

  it("runs the OAuth 2 and OAuth 1 round trips with a checked state, as strapi-php does", async () => {
    const oauth = content("app/Support/StrapiOAuth.php");
    expect(oauth).toContain("'OAuth2 state mismatch'");
    expect(oauth).toContain("'OAuth2 missing code parameter'");
    expect(oauth).toContain("'OAuth1 token mismatch'");
    expect(oauth).toContain("hash_hmac('sha1', ");
    expect(oauth).toContain("bin2hex(random_bytes(20))");
    await expect(oauth).toMatchFileSnapshot("./__golden__/strapi-api/StrapiOAuth.php");
  });

  it("verifies a Cognito id token against the provider's keys", () => {
    expect(content("app/Support/StrapiOAuth.php")).toContain("openssl_verify(");
  });

  it("answers connect and the provider callback with Strapi's errors", async () => {
    const controller = content("app/Http/Controllers/Api/ConnectController.php");
    expect(controller).toContain("'This provider is disabled'");
    expect(controller).toContain("'OAuth authentication requires a completed provider session'");
    expect(controller).toContain("'Invalid callback URL provided'");
    await expect(controller).toMatchFileSnapshot("./__golden__/strapi-api/ConnectController.php");
  });

  it("refuses an email login when email sign-in is turned off", () => {
    const auth = content("app/Http/Controllers/Api/AuthController.php");
    const login = auth.slice(auth.indexOf("public function login"));
    expect(login).toContain("if (! StrapiProviders::enabled('email')) {");
    expect(login.indexOf("StrapiProviders::enabled('email')")).toBeLessThan(
      login.indexOf("StrapiUsers::validate("),
    );
  });

  it("routes the round trip through a session, for callers without one of Strapi's", () => {
    const routes = content("routes/api.php");
    expect(routes).toContain(
      "Route::middleware([EncryptCookies::class, AddQueuedCookiesToResponse::class, StartSession::class, StrapiCredentials::class.':guest'])->group(function () use ($authThrottle): void {",
    );
    expect(routes).toContain(
      "Route::get('/connect/{provider}', [ConnectController::class, 'connect'])->middleware($authThrottle);",
    );
    expect(routes).toContain(
      "Route::get('/connect/{provider}/callback', [ConnectController::class, 'callback'])->middleware($authThrottle);",
    );
    expect(routes).toContain(
      "Route::get('/auth/{provider}/callback', [ConnectController::class, 'signIn']);",
    );
  });

  it("lets an account made through a provider have no password", () => {
    const migration = content(
      "database/migrations/0001_01_02_000004_allow_users_without_password.php",
    );
    expect(migration).toContain("$table->string('password')->nullable()->change();");
  });

  it("edits the providers on the admin's Users & Permissions page", () => {
    const page = content("app/Filament/Pages/UsersPermissionsSettings.php");
    expect(page).toContain("Section::make('Providers')->statePath('grant')");
    expect(page).toContain("StrapiSettings::merge('users-permissions.grant', $state['grant']);");
  });
});
