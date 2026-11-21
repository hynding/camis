import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { IrBundle } from "@camis/permissions";
import { strapiAdapter } from "../generate";
import { publicReadBundle, someConditionsBundle } from "../__fixtures__/note-grants";

const generatedFiles = (bundle: IrBundle) =>
  strapiAdapter.generate(bundle, { projectName: "notes" }).files;

const fileContent = (bundle: IrBundle, path: string): string =>
  generatedFiles(bundle).find((f) => f.path === path)!.content;

const relativeImports = (source: string): string[] =>
  [...source.matchAll(/^import .* from "(\.\/[^"]+)";$/gm)].map((m) => m[1]!);

/** The path Strapi's TypeScript build resolves a relative import of `src/index.ts` to. */
const resolvedPath = (specifier: string): string => {
  const path = `src/${specifier.slice(2)}`;
  return path.endsWith(".json") ? path : `${path}.ts`;
};

/**
 * Strapi 5's query engine binds an admin permission's absent `conditions` (a json column) as
 * `undefined`, which sqlite refuses: the first boot of the project crashes.
 */
const sqliteAdminPermissionCreate = async ({ data }: { data: Record<string, unknown> }) => {
  if (!Array.isArray(data.conditions)) {
    throw new TypeError(
      "insert into `admin_permissions` - SQLite3 can only bind numbers, strings, bigints, buffers, and null",
    );
  }
  return { id: 1 };
};

const runBootstrap = async (bundle: IrBundle): Promise<Record<string, unknown>[]> => {
  const index = fileContent(bundle, "src/index.ts");
  const js = ts
    .transpileModule(index, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    })
    .outputText.replace(/^import .*$/gm, "")
    .replace("export default", "return");
  const module = new Function("conditions", "roles", "apiRoles", js) as (...args: unknown[]) => {
    bootstrap: (p: { strapi: unknown }) => Promise<void>;
  };
  const created: Record<string, unknown>[] = [];
  const query = (uid: string) => ({
    findOne: async () => null,
    findMany: async () => [],
    delete: async () => undefined,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (uid !== "admin::permission") return { id: 1 };
      const row = await sqliteAdminPermissionCreate({ data });
      created.push(data);
      return row;
    },
  });
  const strapi = {
    query,
    store: () => ({ get: async () => null, set: async () => undefined }),
    admin: { services: { permission: { conditionProvider: { registerMany: async () => {} } } } },
  };
  const conditions = bundle.roles.some((r) => r.grants.some((g) => g.condition !== undefined))
    ? []
    : undefined;
  const roles: unknown = JSON.parse(fileContent(bundle, "src/permissions/roles.json"));
  const apiRoles: unknown = JSON.parse(fileContent(bundle, "src/permissions/api-roles.json"));
  await module(conditions, roles, apiRoles).bootstrap({ strapi });
  return created;
};

describe("generated bootstrap boots", () => {
  describe.each([
    ["no grant carries a condition", publicReadBundle],
    ["only some grants carry a condition", someConditionsBundle],
  ])("when %s", (_, bundle) => {
    it("imports only modules the project emits", () => {
      const paths = new Set(generatedFiles(bundle).map((f) => f.path));
      for (const specifier of relativeImports(fileContent(bundle, "src/index.ts"))) {
        expect(paths, specifier).toContain(resolvedPath(specifier));
      }
    });

    it("seeds every admin permission, with conditions an empty list when it has none", async () => {
      const created = await runBootstrap(bundle);
      expect(created.length).toBeGreaterThan(0);
      for (const data of created) expect(Array.isArray(data.conditions)).toBe(true);
    });
  });

  it("keeps a grant's condition on its admin permission", async () => {
    const created = await runBootstrap(someConditionsBundle);
    const conditioned = created.filter((d) => (d.conditions as string[]).length > 0);
    expect(conditioned).toHaveLength(1);
  });

  it("a bootstrap without conditions matches the golden", async () => {
    await expect(fileContent(publicReadBundle, "src/index.ts")).toMatchFileSnapshot(
      "../__golden__/permissions.public-read.index.ts.txt",
    );
  });
});
