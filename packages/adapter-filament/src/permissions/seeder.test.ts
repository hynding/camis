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
      "Role::firstOrCreate(['name' => 'Editor'])->givePermissionTo(['article.read', 'article.update']);",
    );
  });
});
