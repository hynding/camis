import { describe, expect, it } from "vitest";
import { skeletonFiles } from "./skeleton";

describe("skeletonFiles", () => {
  it("emits the minimal bootable Strapi project files", () => {
    const paths = skeletonFiles("blog")
      .map((f) => f.path)
      .sort();
    expect(paths).toEqual([
      ".env",
      "config/admin.ts",
      "config/api.ts",
      "config/database.ts",
      "config/middlewares.ts",
      "config/server.ts",
      "package.json",
      "src/index.ts",
      "tsconfig.json",
    ]);
  });

  it("pins @strapi/strapi to an exact version and sets the project name", () => {
    const pkg = JSON.parse(skeletonFiles("blog").find((f) => f.path === "package.json")!.content);
    expect(pkg.name).toBe("blog");
    expect(pkg.dependencies["@strapi/strapi"]).toMatch(/^5\.\d+\.\d+$/);
  });

  it("marks .env as seed mode with deterministic placeholder secrets", () => {
    const env = skeletonFiles("blog").find((f) => f.path === ".env")!;
    expect(env.mode).toBe("seed");
    expect(env.content).toContain("APP_KEYS=");
  });

  it("database.ts defaults to sqlite", () => {
    const db = skeletonFiles("blog").find((f) => f.path === "config/database.ts")!;
    expect(db.content).toContain("sqlite");
  });
});
