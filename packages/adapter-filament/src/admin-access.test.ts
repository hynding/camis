import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { filamentAdapter } from "./generate";

// Who may sign in to the admin: users holding a role the IR marks `admin` (owner's call,
// 2026-10-29). Filament refuses every user outside APP_ENV=local unless the model says otherwise,
// so the User model's canAccessPanel (the generated AdminAccess trait) is what lets anyone in.
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

describe("admin access", () => {
  const result = filamentAdapter.generate(bundle([editor, reader]), { projectName: "blog" });

  it("lets in only users holding an admin role, and never a blocked one", () => {
    const trait = file(result, TRAIT);
    expect(trait).toContain("trait AdminAccess");
    expect(trait).toContain("public const ADMIN_ROLES = ['Editor'];");
    expect(trait).toContain("public function canAccessPanel(Panel $panel): bool");
    expect(trait).toContain("$this->hasAnyRole(self::ADMIN_ROLES)");
    expect(trait).toContain("$this->getAttribute('blocked')");
  });

  it("makes the first admin with camis:admin", () => {
    const command = file(result, COMMAND);
    expect(command).toContain("protected $signature = 'camis:admin");
    // PHP refuses a trait's constant read through the trait, so the command reads them off User.
    expect(command).toContain("User::ADMIN_ROLES");
    expect(command).not.toMatch(/AdminAccess::[A-Z]/);
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
    expect(file(closed, COMMAND)).toContain("! User::EVERY_USER && User::ADMIN_ROLES === []");
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

  it("tells a deploy how to make the first admin, and how to let an older app's User model in", () => {
    const deploy = file(result, "DEPLOY.md");
    expect(deploy).toContain("## Admin sign-in");
    expect(deploy).toContain("php artisan camis:admin admin@example.com");
    expect(deploy).toContain("implements \\Filament\\Models\\Contracts\\FilamentUser");
    expect(deploy).toContain("\\App\\Models\\Concerns\\AdminAccess");
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
    expect(file(strapi, "DEPLOY.md")).not.toContain("camis:admin");
  });
});
