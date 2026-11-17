import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../../generate";
import { strapiApiBundle } from "../__fixtures__/strapi-api";

// Strapi 5's admin tokens (`kind: 'admin'`), which act in the admin as the account that made them;
// AdminTokensTest.php runs them in a booted app.
describe("admin tokens", () => {
  const result = filamentAdapter.generate(strapiApiBundle, {
    projectName: "oyl",
    apiStyle: "strapi",
  });
  const paths = result.files.map((f) => f.path);
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("keeps them beside the content API tokens, owned by an admin account", () => {
    const migration = content(
      "database/migrations/0001_01_02_000008_add_admin_tokens_to_strapi_api_tokens_table.php",
    );
    expect(migration).toContain("$table->string('kind', 16)->default('content-api');");
    expect(migration).toContain(
      "$table->foreignId('admin_user_owner_id')->nullable()->constrained('admin_users')->cascadeOnDelete();",
    );
    expect(content("app/Models/StrapiApiToken.php")).toContain(
      "$query->where('kind', 'content-api')",
    );
    expect(content("app/Models/StrapiAdminToken.php")).toContain(
      "static::addGlobalScope('admin', fn (Builder $query) => $query->where('kind', 'admin'));",
    );
  });

  it("names each permission as Strapi's admin does", async () => {
    const map = content("app/Support/StrapiAdminPermissions.php");
    expect(map).toContain(
      "'post.publish' => ['plugin::content-manager.explorer.publish', 'api::post.post'],",
    );
    expect(map).toContain("'file.create' => ['plugin::upload.assets.create', null],");
    expect(map).toContain(
      "'user.read' => ['plugin::content-manager.explorer.read', 'plugin::users-permissions.user'],",
    );
    await expect(map).toMatchFileSnapshot("../__golden__/strapi-api/StrapiAdminPermissions.php");
  });

  it("serves Strapi's /admin/admin-tokens routes and the Admin Tokens page", () => {
    const routes = content("routes/admin.php");
    expect(routes).toContain(
      "Route::get('/admin/admin-tokens/{id}/owner-permissions', [StrapiAdminTokensController::class, 'ownerPermissions'])",
    );
    expect(paths).toContain("app/Http/Controllers/Admin/StrapiAdminTokensController.php");
    expect(paths).toContain("app/Support/StrapiAdminTokens.php");
    expect(content("app/Filament/Resources/AdminTokens/AdminTokenResource.php")).toContain(
      "protected static ?string $slug = 'settings/admin-tokens';",
    );
  });

  it("is left out of an app without roles, which has no admin accounts to own one", () => {
    const open = filamentAdapter.generate(
      { ...strapiApiBundle, roles: [] },
      { projectName: "oyl", apiStyle: "strapi" },
    );
    expect(open.files.map((f) => f.path)).not.toContain("app/Support/StrapiAdminTokens.php");
  });
});
