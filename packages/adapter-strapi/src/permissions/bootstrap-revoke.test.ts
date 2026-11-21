import ts from "typescript";
import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { ownershipBundle } from "../__fixtures__/ownership";

interface PermissionRow {
  id: number;
  action: string;
  role: number;
}

/** The generated bootstrap, run against an in-memory users-permissions store. */
const runBootstrap = async (
  apiRoles: { roles: { type: string; actions: string[] }[]; public: string[]; managed: string[] },
  seeded: PermissionRow[],
): Promise<PermissionRow[]> => {
  const index = strapiAdapter
    .generate(ownershipBundle, { projectName: "notes" })
    .files.find((f) => f.path === "src/index.ts")!.content;
  const js = ts
    .transpileModule(index, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    })
    .outputText.replace(/^import .*$/gm, "")
    .replace("export default", "return");
  const module = new Function("conditions", "roles", "apiRoles", js) as (...args: unknown[]) => {
    bootstrap: (p: { strapi: unknown }) => Promise<void>;
  };

  const upRoles = [
    { id: 1, type: "public" },
    { id: 2, type: "member" },
  ];
  let permissions = [...seeded];
  const query = (uid: string) => {
    if (uid === "plugin::users-permissions.role")
      return {
        findOne: async ({ where }: { where: { type: string } }) =>
          upRoles.find((r) => r.type === where.type) ?? null,
        create: async ({ data }: { data: { type: string } }) => {
          const role = { id: upRoles.length + 1, type: data.type };
          upRoles.push(role);
          return role;
        },
      };
    if (uid === "plugin::users-permissions.permission")
      return {
        findOne: async ({ where }: { where: { action: string; role: number } }) =>
          permissions.find((p) => p.action === where.action && p.role === where.role) ?? null,
        findMany: async ({ where }: { where: { role: number } }) =>
          permissions.filter((p) => p.role === where.role),
        create: async ({ data }: { data: { action: string; role: number } }) => {
          permissions.push({ id: permissions.length + 100, ...data });
        },
        delete: async ({ where }: { where: { id: number } }) => {
          permissions = permissions.filter((p) => p.id !== where.id);
        },
      };
    return { findOne: async () => ({ id: 1 }), create: async () => ({ id: 1 }) };
  };
  const strapi = {
    admin: { services: { permission: { conditionProvider: { registerMany: async () => {} } } } },
    query,
  };
  await module([], [], apiRoles).bootstrap({ strapi });
  return permissions;
};

const USER_FIND = "plugin::users-permissions.user.find";
const USER_ME = "plugin::users-permissions.user.me";

describe("the generated bootstrap's revoke", () => {
  const seeded: PermissionRow[] = [
    { id: 1, action: USER_FIND, role: 2 },
    { id: 2, action: USER_ME, role: 2 },
    { id: 3, action: "api::note.note.find", role: 2 },
  ];

  // An earlier generation granted user.find for the owner relation; once the owner is assigned on
  // the server, the next boot must take it back, not leave GET /api/users open forever.
  it("revokes a plugin action camis manages and no longer grants", async () => {
    const after = await runBootstrap(
      {
        roles: [{ type: "member", actions: ["api::note.note.find"] }],
        public: [],
        managed: [USER_FIND],
      },
      seeded,
    );
    expect(
      after
        .filter((p) => p.role === 2)
        .map((p) => p.action)
        .sort(),
    ).toEqual(["api::note.note.find", USER_ME]);
  });
  it("keeps a managed plugin action camis still grants", async () => {
    const after = await runBootstrap(
      {
        roles: [{ type: "member", actions: ["api::note.note.find", USER_FIND] }],
        public: [],
        managed: [USER_FIND],
      },
      seeded,
    );
    expect(after.filter((p) => p.role === 2).map((p) => p.action)).toContain(USER_FIND);
  });
  it("never touches a plugin action camis does not manage", async () => {
    const after = await runBootstrap(
      { roles: [{ type: "member", actions: [] }], public: [], managed: [] },
      seeded,
    );
    expect(
      after
        .filter((p) => p.role === 2)
        .map((p) => p.action)
        .sort(),
    ).toEqual([USER_FIND, USER_ME]);
  });
});
