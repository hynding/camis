import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { ownershipBundle } from "../__fixtures__/ownership";

// Every content API action a role of the boot job's project may reach must say where it is
// enforced or why it is safe. The boot job checks the same list against the routes Strapi
// registers and the permissions its roles hold; this checks it against what camis grants.
const allowlist = JSON.parse(
  readFileSync(new URL("../../scripts/content-api-allowlist.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

describe("the content API allowlist", () => {
  it("names every action the ownership project grants a role, each with a reason", () => {
    const files = strapiAdapter.generate(ownershipBundle, { projectName: "notes" }).files;
    const apiRoles = JSON.parse(
      files.find((f) => f.path === "src/permissions/api-roles.json")!.content,
    ) as { roles: { actions: string[] }[]; public: string[] };
    const granted = new Set([...apiRoles.public, ...apiRoles.roles.flatMap((r) => r.actions)]);
    for (const action of granted) {
      expect(typeof allowlist[action], action).toBe("string");
      expect((allowlist[action] as string).length, action).toBeGreaterThan(20);
    }
  });
});
