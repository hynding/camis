import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { permissionsBundle } from "../__fixtures__/permissions";

describe("permissions golden", () => {
  const result = strapiAdapter.generate(permissionsBundle, { projectName: "blog" });

  it("roles.json matches the golden", async () => {
    const roles = result.files.find((f) => f.path === "src/permissions/roles.json")!.content;
    await expect(roles).toMatchFileSnapshot("../__golden__/permissions.roles.json");
  });
  it("conditions.ts matches the golden", async () => {
    const conditions = result.files.find(
      (f) => f.path === "src/permissions/conditions.ts",
    )!.content;
    await expect(conditions).toMatchFileSnapshot("../__golden__/permissions.conditions.ts.txt");
  });
  it("bootstrap index.ts matches the golden", async () => {
    const index = result.files.find((f) => f.path === "src/index.ts")!.content;
    await expect(index).toMatchFileSnapshot("../__golden__/permissions.index.ts.txt");
  });
  // Granting alone is one-way: a grant deleted from the IR stayed in a database an earlier
  // generation seeded, so the role kept an API permission camis no longer emits. The bootstrap
  // therefore revokes too — but only rows it owns: the `plugin::*` rows are Strapi's own defaults
  // (users-permissions' `user.me`, the auth endpoints), and deleting those breaks login itself.
  it("bootstrap revokes stale api:: permissions and never touches plugin:: ones", () => {
    const index = result.files.find((f) => f.path === "src/index.ts")!.content;
    expect(index).toContain(
      'const owned = await strapi.query("plugin::users-permissions.permission").findMany({ where: { role: role.id } });',
    );
    expect(index).toContain('if (!p.action.startsWith("api::")) continue;');
    expect(index).toContain("if (actions.includes(p.action)) continue;");
    expect(index).toContain(
      'await strapi.query("plugin::users-permissions.permission").delete({ where: { id: p.id } });',
    );
    // Revocation runs per managed role, inside grant(), so `public` and every api-roles.json role
    // is covered and no role absent from the IR is touched.
    expect(index.indexOf("const owned =")).toBeGreaterThan(index.indexOf("const grant ="));
    expect(index.indexOf("const owned =")).toBeLessThan(index.indexOf('await grant("public"'));
  });

  it("api-roles.json matches the golden", async () => {
    const apiRoles = result.files.find((f) => f.path === "src/permissions/api-roles.json")!.content;
    await expect(apiRoles).toMatchFileSnapshot("../__golden__/permissions.api-roles.json");
  });
  it("gap report lists only the API-condition downgrade", () => {
    expect(result.gaps.gaps).toEqual([
      {
        feature: "apiGrantCondition",
        location: { contentType: "Article", rule: "Editor" },
        severity: "downgrade",
        message:
          '"Editor" grant on "Article" is unconditioned at the users-permissions API; conditions apply to the admin panel only',
      },
    ]);
  });
  it("regeneration is idempotent", () => {
    const again = strapiAdapter.generate(permissionsBundle, { projectName: "blog" });
    expect(again).toEqual(result);
  });
});
