import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { skeletonFiles } from "./skeleton";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    { name: "Article", kind: "collection", fields: [{ type: "string", name: "title" }] },
  ],
  components: [],
};

describe("skeletonFiles", () => {
  const files = skeletonFiles(doc, "blog", "sqlite");
  const c = (p: string) => files.find((f) => f.path === p)!.content;
  it("emits package.json with deps + scripts", () => {
    const pkg = JSON.parse(c("package.json"));
    expect(pkg.name).toBe("blog");
    expect(pkg.dependencies["drizzle-orm"]).toBeDefined();
    expect(pkg.scripts["db:push"]).toBe("drizzle-kit push");
  });
  it("emits drizzle.config, client, server (mounting the router), index, .env (seed)", () => {
    expect(c("drizzle.config.ts")).toContain('dialect: "sqlite"');
    expect(c("src/db/client.ts")).toContain("drizzle(new Database(");
    expect(c("src/server.ts")).toContain('app.use("/api/articles", articlesRouter);');
    expect(c("src/index.ts")).toContain("app.listen(");
    const env = files.find((f) => f.path === ".env")!;
    expect(env.mode).toBe("seed");
  });
  it("pg skeleton uses postgres driver + dialect", () => {
    const files = skeletonFiles(doc, "blog", "pgsql");
    const c = (p: string) => files.find((f) => f.path === p)!.content;
    expect(JSON.parse(c("package.json")).dependencies["postgres"]).toBeDefined();
    expect(c("src/db/client.ts")).toContain("drizzle-orm/postgres-js");
    expect(c("drizzle.config.ts")).toContain('dialect: "postgresql"');
  });
  it("unsecured server has no auth wiring (8A/8B compatible)", () => {
    const files = skeletonFiles(doc, "blog", "sqlite");
    expect(files.find((f) => f.path === "src/server.ts")!.content).not.toContain("authRouter");
  });
  it("secured server mounts verify + /auth and adds jsonwebtoken", () => {
    const files = skeletonFiles(doc, "blog", "sqlite", { secured: true });
    const server = files.find((f) => f.path === "src/server.ts")!.content;
    expect(server).toContain('import { verify } from "./auth/verify";');
    expect(server).toContain('app.use("/auth", authRouter);');
    expect(server).toContain("app.use(verify);");
    expect(
      JSON.parse(files.find((f) => f.path === "package.json")!.content).dependencies[
        "jsonwebtoken"
      ],
    ).toBeDefined();
  });
});
