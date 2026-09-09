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
      "public/uploads/.gitkeep",
      "src/index.ts",
      "tsconfig.json",
    ]);
  });

  // Strapi's local upload provider refuses to register when public/uploads is missing, so a
  // generated project without this placeholder cannot boot at all.
  it("creates public/uploads so the local upload provider can register", () => {
    const keep = skeletonFiles("blog").find((f) => f.path === "public/uploads/.gitkeep")!;
    expect(keep).toBeDefined();
    expect(keep.mode).toBe("seed");
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

  // path.join would splice an absolute DATABASE_FILENAME under the project root and open a
  // different, empty file — the exact failure mode of pointing Strapi at a database another app
  // already owns. path.resolve honors an absolute value and still resolves a relative one against
  // the project root.
  it("database.ts resolves DATABASE_FILENAME so an absolute path is honored", () => {
    const db = skeletonFiles("blog").find((f) => f.path === "config/database.ts")!;
    expect(db.content).toContain(
      "path.resolve(__dirname, '..', '..', env('DATABASE_FILENAME', '.tmp/data.db'))",
    );
    expect(db.content).not.toContain("path.join(");
  });
});
