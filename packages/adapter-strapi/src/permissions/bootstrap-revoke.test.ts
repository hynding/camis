import ts from "typescript";
import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { ownershipBundle } from "../__fixtures__/ownership";

interface PermissionRow {
  id: number;
  action: string;
  role: number;
}

interface ApiRoles {
  roles: { type: string; actions: string[] }[];
  public: string[];
}

/** A Strapi database as the generated bootstrap sees it: permissions, roles and the core store. */
interface Database {
  permissions: PermissionRow[];
  store: Map<string, unknown>;
  /** What the bootstrap hands Strapi's query engine for each admin-panel permission. */
  adminPermissions?: Record<string, unknown>[];
}

/** The generated bootstrap, run against an in-memory users-permissions database. */
const runBootstrap = async (apiRoles: ApiRoles, db: Database): Promise<void> => {
  const files = strapiAdapter.generate(ownershipBundle, { projectName: "notes" }).files;
  const index = files.find((f) => f.path === "src/index.ts")!.content;
  const adminRoles: unknown = JSON.parse(
    files.find((f) => f.path === "src/permissions/roles.json")!.content,
  );
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
          db.permissions.find((p) => p.action === where.action && p.role === where.role) ?? null,
        findMany: async ({ where }: { where: { role: number } }) =>
          db.permissions.filter((p) => p.role === where.role),
        create: async ({ data }: { data: { action: string; role: number } }) => {
          db.permissions.push({ id: db.permissions.length + 100, ...data });
        },
        delete: async ({ where }: { where: { id: number } }) => {
          db.permissions = db.permissions.filter((p) => p.id !== where.id);
        },
      };
    if (uid === "admin::permission")
      return {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          db.adminPermissions?.push(data);
          return { id: 1 };
        },
      };
    return { findOne: async () => ({ id: 1 }), create: async () => ({ id: 1 }) };
  };
  // Strapi's core store, as `strapi.store({ type, name })` hands it out.
  const store = ({ type, name }: { type: string; name: string }) => ({
    get: async ({ key }: { key: string }) => db.store.get(`${type}:${name}:${key}`) ?? null,
    set: async ({ key, value }: { key: string; value: unknown }) => {
      db.store.set(`${type}:${name}:${key}`, structuredClone(value));
    },
  });
  const strapi = {
    admin: { services: { permission: { conditionProvider: { registerMany: async () => {} } } } },
    query,
    store,
  };
  await module([], adminRoles, apiRoles).bootstrap({ strapi });
};

const USER_FIND = "plugin::users-permissions.user.find";
const USER_ME = "plugin::users-permissions.user.me";
const REGISTER = "plugin::users-permissions.auth.register";
const actionsOf = (db: Database, role: number): string[] =>
  db.permissions
    .filter((p) => p.role === role)
    .map((p) => p.action)
    .sort();

describe("the generated bootstrap's revoke", () => {
  // An earlier boot granted user.find for the owner relation; once the owner is assigned on the
  // server, the next boot takes it back rather than leave GET /api/users open.
  it("revokes a plugin action an earlier boot of it granted and it no longer grants", async () => {
    const db: Database = { permissions: [{ id: 2, action: USER_ME, role: 2 }], store: new Map() };
    await runBootstrap({ roles: [{ type: "member", actions: [USER_FIND] }], public: [] }, db);
    expect(actionsOf(db, 2)).toEqual([USER_FIND, USER_ME]);
    await runBootstrap(
      { roles: [{ type: "member", actions: ["api::note.note.find"] }], public: [] },
      db,
    );
    expect(actionsOf(db, 2)).toEqual(["api::note.note.find", USER_ME]);
  });
  it("keeps a plugin action an administrator granted by hand, even one camis also granted", async () => {
    const db: Database = { permissions: [{ id: 1, action: USER_FIND, role: 2 }], store: new Map() };
    await runBootstrap({ roles: [{ type: "member", actions: [USER_FIND] }], public: [] }, db);
    await runBootstrap({ roles: [{ type: "member", actions: [] }], public: [] }, db);
    expect(actionsOf(db, 2)).toEqual([USER_FIND]);
  });
  it("never touches a plugin action it did not grant", async () => {
    const db: Database = {
      permissions: [
        { id: 1, action: USER_FIND, role: 2 },
        { id: 2, action: USER_ME, role: 2 },
      ],
      store: new Map(),
    };
    await runBootstrap({ roles: [{ type: "member", actions: [] }], public: [] }, db);
    expect(actionsOf(db, 2)).toEqual([USER_FIND, USER_ME]);
  });
  // The public role is granted the registration actions and its IR grants in one pass, so the
  // second never revokes what the first just granted.
  it("keeps the public role's registration actions beside its own grants", async () => {
    const db: Database = { permissions: [], store: new Map() };
    const apiRoles = {
      roles: [{ type: "public", actions: ["api::note.note.find"] }],
      public: [REGISTER],
    };
    await runBootstrap(apiRoles, db);
    await runBootstrap(apiRoles, db);
    expect(actionsOf(db, 1)).toEqual(["api::note.note.find", REGISTER]);
  });
});

describe("the generated bootstrap's admin-panel permissions", () => {
  // Strapi 5's query engine binds a json attribute's default ([]) unserialised, which sqlite
  // refuses: a permission without conditions failed the boot.
  it("creates every admin permission with its conditions, an empty list when it has none", async () => {
    const db: Database = { permissions: [], store: new Map(), adminPermissions: [] };
    await runBootstrap({ roles: [], public: [] }, db);
    expect(db.adminPermissions!.length).toBeGreaterThan(0);
    for (const p of db.adminPermissions!)
      expect(Array.isArray(p.conditions), JSON.stringify(p)).toBe(true);
  });
});
