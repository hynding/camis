import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "./generate";

// Who may sign in to the admin: admin accounts holding a role the IR marks `admin` (owner's call,
// 2026-10-29). Admin accounts live apart from the API's users, as Strapi keeps admin_users apart
// from up_users (owner's call, 2026-11-10): Filament signs in on the web guard, whose provider is
// the AdminUser model, and its canAccessPanel (the generated AdminAccess trait) lets anyone in.
const bundle = (roles: IrBundle["roles"]): IrBundle => ({
  document: {
    version: 1,
    contentTypes: [
      { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
    ],
    components: [],
  },
  roles,
});
const editor = {
  name: "Editor",
  admin: true,
  grants: [{ contentType: "Article", actions: ["read", "update"] }],
} satisfies IrBundle["roles"][number];
const reader = {
  name: "Reader",
  grants: [{ contentType: "Article", actions: ["read"] }],
} satisfies IrBundle["roles"][number];

const file = (result: ReturnType<typeof filamentAdapter.generate>, path: string): string =>
  result.files.find((f) => f.path === path)?.content ?? "";
const TRAIT = "app/Models/Concerns/AdminAccess.php";
const COMMAND = "app/Console/Commands/CamisAdmin.php";
const MODEL = "app/Models/AdminUser.php";
const MIGRATION = "database/migrations/0001_01_01_000003_create_admin_users_table.php";
const AUTH_CONFIG = "config/auth.php";

describe("admin access", () => {
  const result = filamentAdapter.generate(bundle([editor, reader]), { projectName: "blog" });

  it("lets in only active accounts holding an admin role, and never a blocked one", () => {
    const trait = file(result, TRAIT);
    expect(trait).toContain("trait AdminAccess");
    expect(trait).toContain("public const ADMIN_ROLES = ['Editor'];");
    expect(trait).toContain("public function canAccessPanel(Panel $panel): bool");
    expect(trait).toContain("$this->hasAnyRole(self::ADMIN_ROLES)");
    expect(trait).toContain("$this->getAttribute('blocked')");
    expect(trait).toContain("$this->getAttribute('is_active')");
  });

  it("keeps admin accounts in Strapi's admin_users table, apart from the API's users", () => {
    const migration = file(result, MIGRATION);
    expect(migration).toContain("Schema::create('admin_users'");
    for (const column of ["firstname", "lastname", "username", "prefered_language"]) {
      expect(migration).toContain(`$table->string('${column}')->nullable();`);
    }
    expect(migration).toContain("$table->string('email')->unique();");
    expect(migration).toContain("$table->boolean('is_active')->default(false);");
    expect(migration).toContain("$table->boolean('blocked')->default(false);");
    const model = file(result, MODEL);
    expect(model).toContain(
      "class AdminUser extends Authenticatable implements FilamentUser, HasName",
    );
    expect(model).toContain("use AdminAccess, HasRoles, Notifiable;");
    expect(model).toContain("protected $table = 'admin_users';");
  });

  it("signs the admin in on its own guard as an AdminUser, and leaves the web guard to the API's users", () => {
    const auth = file(result, AUTH_CONFIG);
    expect(auth).toContain(
      "'admin' => [\n            'driver' => 'session',\n            'provider' => 'admin_users',",
    );
    expect(auth).toContain(
      "'web' => [\n            'driver' => 'session',\n            'provider' => 'users',",
    );
    expect(auth).toContain("'model' => App\\Models\\AdminUser::class,");
    expect(auth).toContain("'model' => env('AUTH_MODEL', App\\Models\\User::class),");
    // Spatie reads an account's roles on its guard; the IR's roles are seeded on the web guard.
    expect(file(result, MODEL)).toContain("protected string $guard_name = 'web';");
  });

  it("makes the first admin account with camis:admin", () => {
    const command = file(result, COMMAND);
    expect(command).toContain("protected $signature = 'camis:admin");
    // PHP refuses a trait's constant read through the trait, so the command reads them off the model.
    expect(command).toContain("AdminUser::adminRoles()");
    expect(command).not.toMatch(/AdminAccess::[A-Z]/);
    expect(command).not.toContain("App\\Models\\User;");
    expect(command).toContain("'is_active' => true");
    expect(command).toContain("assignRole(");
  });

  it("lets every signed-in user in when the project has no roles at all", () => {
    const open = filamentAdapter.generate(bundle([]), { projectName: "blog" });
    expect(file(open, TRAIT)).toContain("public const ADMIN_ROLES = [];");
    expect(file(open, TRAIT)).toContain("return true;");
    expect(file(open, TRAIT)).toContain("public const EVERY_USER = true;");
    expect(open.gaps.gaps.filter((g) => g.feature === "adminRole")).toEqual([]);
  });

  // Strapi's own roles (authenticated, public) are API roles: a user who signed up through the API
  // must not reach the admin just because no role was flagged.
  it("lets no user in when roles exist but none is an admin role", () => {
    const closed = filamentAdapter.generate(bundle([reader]), { projectName: "blog" });
    expect(file(closed, TRAIT)).toContain("public const EVERY_USER = false;");
    expect(file(closed, TRAIT)).toContain("$this->hasAnyRole(self::ADMIN_ROLES)");
    expect(file(closed, TRAIT)).not.toContain("return true;");
    expect(file(closed, COMMAND)).toContain("! AdminUser::everyUser() && $roles === []");
  });

  it("reports a project whose roles let nobody in", () => {
    const closed = filamentAdapter.generate(bundle([reader]), { projectName: "blog" });
    expect(closed.gaps.gaps.filter((g) => g.feature === "adminRole")).toEqual([
      {
        feature: "adminRole",
        location: {},
        severity: "downgrade",
        message:
          'no role may sign in to the admin: mark one with "admin": true, then run php artisan camis:admin',
      },
    ]);
  });

  it("tells a deploy how to make the first admin, and what an older app's admins need", () => {
    const deploy = file(result, "DEPLOY.md");
    expect(deploy).toContain("## Admin sign-in");
    expect(deploy).toContain("php artisan camis:admin admin@example.com");
    expect(deploy).toContain("`admin_users`");
    expect(deploy).toContain("config/auth.php");
  });

  it("has no admin to let anyone into on the Strapi storage layout", () => {
    const strapi = filamentAdapter.generate(bundle([editor]), {
      projectName: "blog",
      apiStyle: "strapi",
      storageLayout: "strapi",
    });
    const paths = strapi.files.map((f) => f.path);
    expect(paths).not.toContain(TRAIT);
    expect(paths).not.toContain(COMMAND);
    expect(paths).not.toContain(MODEL);
    expect(paths).not.toContain(AUTH_CONFIG);
    expect(file(strapi, "DEPLOY.md")).not.toContain("camis:admin");
  });
});
