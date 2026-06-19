import { describe, expect, it } from "vitest";
import { adminStaticFiles } from "./admin-app";

describe("adminStaticFiles", () => {
  const files = adminStaticFiles();
  const c = (p: string) => files.find((f) => f.path === p)!.content;
  it("emits a vite + react-admin package.json", () => {
    const pkg = JSON.parse(c("admin/package.json"));
    expect(pkg.dependencies["react-admin"]).toBeDefined();
    expect(pkg.dependencies.react).toBeDefined();
    expect(pkg.devDependencies.vite).toBeDefined();
    expect(pkg.scripts.build).toBe("tsc && vite build");
  });
  it("emits a dataProvider that reads Content-Range and attaches a Bearer token", () => {
    const dp = c("admin/src/dataProvider.ts");
    expect(dp).toContain("Content-Range");
    expect(dp).toContain("Authorization");
    expect(dp).toContain("_start");
    expect(dp).toContain("getManyReference");
  });
  it("emits an authProvider that logs in via /auth/login and decodes the role", () => {
    const ap = c("admin/src/authProvider.ts");
    expect(ap).toContain("/auth/login");
    expect(ap).toContain("getPermissions");
    expect(ap).toContain("localStorage");
  });
  it("emits the vite entry and index.html", () => {
    expect(c("admin/index.html")).toContain('<div id="root">');
    expect(c("admin/src/main.tsx")).toContain("createRoot");
  });
});
