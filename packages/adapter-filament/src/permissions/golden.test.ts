import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { permissionsBundle } from "../__fixtures__/permissions";

describe("permissions golden", () => {
  const result = filamentAdapter.generate(permissionsBundle, { projectName: "blog" });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("seeder golden", async () => {
    await expect(content("database/seeders/RolePermissionSeeder.php")).toMatchFileSnapshot(
      "./__golden__/permissions/RolePermissionSeeder.php",
    );
  });
  it("policy golden", async () => {
    await expect(content("app/Policies/ArticlePolicy.php")).toMatchFileSnapshot(
      "./__golden__/permissions/ArticlePolicy.php",
    );
  });
  it("Ring1 support golden", async () => {
    await expect(content("app/Support/Ring1.php")).toMatchFileSnapshot(
      "./__golden__/permissions/Ring1.php",
    );
  });
  it("regeneration is idempotent", () => {
    expect(filamentAdapter.generate(permissionsBundle, { projectName: "blog" })).toEqual(result);
  });
});
