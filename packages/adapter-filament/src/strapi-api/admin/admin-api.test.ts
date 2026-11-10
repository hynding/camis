import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../../generate";
import { strapiApiBundle } from "../__fixtures__/strapi-api";

// Strapi's admin accounts and the part of its admin API a client signs in through: the admin's
// users live in admin_users, apart from the API's users, and a tool such as a conformance runner
// signs in at /admin/login and makes itself an API token at /admin/api-tokens, as it does on Strapi.
describe("Strapi's admin accounts and admin API", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const content = (p: string): string => {
    const file = result.files.find((f) => f.path === p);
    if (file === undefined) throw new Error(`${p} was not generated`);
    return file.content;
  };

  it("answers Strapi's admin routes beside Filament's, loaded with the transfer routes", () => {
    const routes = content("routes/admin.php");
    for (const route of [
      "Route::get('/admin/init', [StrapiAdminController::class, 'init']);",
      "Route::post('/admin/login', [StrapiAdminController::class, 'login']);",
      "Route::post('/admin/register-admin', [StrapiAdminController::class, 'registerAdmin']);",
      "Route::get('/admin/users/me', [StrapiAdminController::class, 'me']);",
      "Route::get('/admin/api-tokens', [StrapiAdminApiTokens::class, 'list']);",
      "Route::post('/admin/api-tokens', [StrapiAdminApiTokens::class, 'create']);",
      "Route::get('/admin/api-tokens/{id}', [StrapiAdminApiTokens::class, 'get'])->whereNumber('id');",
      "Route::put('/admin/api-tokens/{id}', [StrapiAdminApiTokens::class, 'update'])->whereNumber('id');",
      "Route::delete('/admin/api-tokens/{id}', [StrapiAdminApiTokens::class, 'revoke'])->whereNumber('id');",
      "Route::post('/admin/api-tokens/{id}/regenerate', [StrapiAdminApiTokens::class, 'regenerate'])->whereNumber('id');",
    ]) {
      expect(routes).toContain(route);
    }
    expect(routes).toContain("Route::middleware([StrapiErrors::class])");
    // bootstrap/app.php loads routes/transfer.php already, so an app built before needs no patch.
    expect(content("routes/transfer.php")).toContain("require __DIR__.'/admin.php';");
  });

  it("moves the API Tokens page to Strapi's settings path, which frees /admin/api-tokens", () => {
    expect(content("app/Filament/Resources/ApiTokens/ApiTokenResource.php")).toContain(
      "protected static ?string $slug = 'settings/api-tokens';",
    );
  });

  it("signs an admin's access token with Strapi's ADMIN_JWT_SECRET, for 30 minutes", () => {
    const auth = content("app/Support/StrapiAdminAuth.php");
    expect(auth).toContain("config('camis.admin_auth.secret')");
    expect(auth).toContain("private const LIFESPAN = 1800;");
    expect(auth).toContain("'type' => 'access'");
    expect(content("config/camis.php")).toContain("'secret' => env('ADMIN_JWT_SECRET'),");
  });

  it("refuses a sign-in as Strapi's local strategy does, and returns its body", () => {
    const controller = content("app/Http/Controllers/Admin/StrapiAdminController.php");
    expect(controller).toContain("'Invalid credentials'");
    expect(controller).toContain("'User not active'");
    expect(controller).toContain("'token' => $token,");
    expect(controller).toContain("'accessToken' => $token,");
    expect(controller).toContain("'hasAdmin' => AdminUser::query()->exists(),");
    expect(controller).toContain("'You cannot register a new super admin'");
  });

  it("lets only an admin who may change accounts handle API tokens, as the API Tokens page does", () => {
    const tokens = content("app/Http/Controllers/Admin/StrapiAdminApiTokens.php");
    expect(tokens).toContain("$admin->can('user.update')");
    expect(tokens).toContain("'accessKey' => $made['accessKey']");
    expect(tokens).toContain("StrapiApiTokens::create(");
    expect(tokens).toContain("StrapiApiTokens::regenerate(");
  });

  it("lists, makes and edits admin accounts on Strapi's Settings › Users page", () => {
    const resource = content("app/Filament/Resources/AdminUsers/AdminUserResource.php");
    expect(resource).toContain("protected static ?string $model = AdminUser::class;");
    expect(resource).toContain("protected static ?string $slug = 'settings/users';");
    expect(resource).toContain("protected static ?string $navigationLabel = 'Admin users';");
    // Only an admin role may be given to an admin account.
    expect(resource).toContain(
      "->relationship('roles', 'name', fn (Builder $query): Builder => $query->whereIn('name', AdminUser::ADMIN_ROLES))",
    );
    expect(resource).toContain("(auth()->user()?->can('user.update') ?? false)");
    expect(content("app/Filament/Resources/AdminUsers/Pages/ListAdminUsers.php")).toContain(
      "class ListAdminUsers extends ListRecords",
    );
    expect(content("app/Filament/Resources/AdminUsers/Pages/CreateAdminUser.php")).toContain(
      "class CreateAdminUser extends CreateRecord",
    );
    expect(content("app/Filament/Resources/AdminUsers/Pages/EditAdminUser.php")).toContain(
      "class EditAdminUser extends EditRecord",
    );
  });

  it("imports a Strapi project's admin accounts from its database, keeping their passwords", () => {
    const command = content("app/Console/Commands/StrapiImportAdmins.php");
    expect(command).toContain("protected $signature = 'strapi:import-admins");
    const engine = content("app/Support/StrapiAdminImport.php");
    expect(engine).toContain("->table('admin_users')");
    expect(engine).toContain("'admin_users_roles_lnk'");
    expect(engine).toContain("'strapi-super-admin'");
    // bcryptjs writes $2a$, which PHP verifies as $2y$.
    expect(engine).toContain("'$2y$'");
  });

  it("counts admin accounts on the Home page", () => {
    expect(content("app/Support/StrapiHomepage.php")).toContain(
      "'admins' => \\App\\Models\\AdminUser::query()",
    );
  });

  it("has none of it without roles, as the API Tokens page", () => {
    const open = filamentAdapter.generate(
      { ...strapiApiBundle, roles: [] },
      { projectName: "oyl", apiStyle: "strapi" },
    );
    const paths = open.files.map((f) => f.path);
    expect(paths).not.toContain("routes/admin.php");
    expect(paths).not.toContain("app/Filament/Resources/AdminUsers/AdminUserResource.php");
    expect(open.files.find((f) => f.path === "routes/transfer.php")!.content).not.toContain(
      "admin.php",
    );
  });
});
