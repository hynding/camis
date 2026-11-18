import { describe, expect, it } from "vitest";
import { emitSeeder } from "./seeder";

describe("emitSeeder", () => {
  const php = emitSeeder(
    ["article.read", "article.update"],
    [{ role: "Editor", keys: ["article.read", "article.update"] }],
  );
  it("creates permissions and roles idempotently", () => {
    expect(php).toContain("namespace Database\\Seeders;");
    expect(php).toContain("class RolePermissionSeeder extends Seeder");
    expect(php).toContain("forgetCachedPermissions();");
    expect(php).toContain("Permission::firstOrCreate(['name' => 'article.read']);");
    expect(php).toContain("Permission::firstOrCreate(['name' => 'article.update']);");
    expect(php).toContain(
      "$role::firstOrCreate(['name' => 'Editor'])->givePermissionTo(['article.read', 'article.update']);",
    );
  });
  // A Strapi API style app's role model keeps Strapi's millisecond timestamps.
  it("creates roles with the role model Spatie is configured with", () => {
    expect(php).toContain("$role = app(PermissionRegistrar::class)->getRoleClass();");
    expect(php).not.toContain("use Spatie\\Permission\\Models\\Role;");
  });
});
