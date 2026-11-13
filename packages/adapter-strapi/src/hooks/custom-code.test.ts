import { describe, expect, it } from "vitest";
import { strapiAdapter } from "../generate";
import { customCodeDoc } from "../__fixtures__/custom-code";
import { hooksDoc } from "../__fixtures__/hooks";

describe("strapi custom code", () => {
  const result = strapiAdapter.generate(
    { document: customCodeDoc, roles: [] },
    { projectName: "blog" },
  );
  const file = (p: string) => result.files.find((f) => f.path === p);
  const golden = (p: string, g: string) =>
    expect(file(p)!.content).toMatchFileSnapshot(`./__golden__/${g}`);

  it("runs a content type's lifecycle hooks from its one lifecycles file", async () => {
    await golden(
      "src/api/article/content-types/article/lifecycles.ts",
      "article.lifecycles.all.ts.txt",
    );
  });

  it("gives a hook that cannot change the record a contract returning nothing", async () => {
    await golden(
      "src/hooks/contracts/announce-article.contract.ts",
      "announce-article.contract.ts.txt",
    );
    expect(file("src/hooks/announce-article.ts")!.mode).toBe("seed");
    await golden("src/hooks/announce-article.ts", "announce-article.stub.ts.txt");
  });

  it("names policies and middlewares in the core router's config", async () => {
    await golden("src/api/article/routes/article.ts", "article.router.ts.txt");
    await golden("src/api/homepage/routes/homepage.ts", "homepage.router.ts.txt");
  });

  // A single type's core router has find, update and delete only.
  it("serves only a type's listed actions through the core router's only", () => {
    const restricted = strapiAdapter.generate(
      {
        document: {
          ...customCodeDoc,
          contentTypes: customCodeDoc.contentTypes.map((ct) => ({
            ...ct,
            options: {
              ...ct.options,
              apiActions: ct.kind === "single" ? ["read"] : ["list", "read"],
            },
          })),
        },
        roles: [],
      },
      { projectName: "blog" },
    );
    const router = (p: string) => restricted.files.find((f) => f.path === p)!.content;
    expect(router("src/api/article/routes/article.ts")).toContain('  only: ["find", "findOne"],\n');
    expect(router("src/api/homepage/routes/homepage.ts")).toContain('  only: ["find"],\n');
    // A policy on an action the type does not serve has no route to run on.
    expect(router("src/api/article/routes/article.ts")).not.toContain("update:");
  });

  it("opens a type's public actions with the route's auth: false", () => {
    const opened = strapiAdapter.generate(
      {
        document: {
          ...customCodeDoc,
          contentTypes: customCodeDoc.contentTypes.map((ct) => ({
            ...ct,
            options: {
              ...ct.options,
              publicApiActions: ct.kind === "single" ? ["read"] : ["list", "update"],
            },
          })),
        },
        roles: [],
      },
      { projectName: "blog" },
    );
    const router = (p: string) => opened.files.find((f) => f.path === p)!.content;
    expect(router("src/api/article/routes/article.ts")).toContain("    find: { auth: false },\n");
    expect(router("src/api/article/routes/article.ts")).toContain(
      '    update: { auth: false, policies: ["global::is-owner"]',
    );
    expect(router("src/api/homepage/routes/homepage.ts")).toContain("    find: { auth: false");
  });

  it("seeds each policy and middleware as Strapi's global ones", async () => {
    expect(file("src/policies/is-owner.ts")!.mode).toBe("seed");
    expect(file("src/middlewares/audit-trail.ts")!.mode).toBe("seed");
    await golden("src/policies/is-owner.ts", "is-owner.policy.ts.txt");
    await golden("src/middlewares/audit-trail.ts", "audit-trail.middleware.ts.txt");
  });

  it("runs schedules as Strapi's cron tasks, enabled in config/server.ts", async () => {
    await golden("config/cron-tasks.ts", "cron-tasks.ts.txt");
    await golden("config/server.ts", "server.cron.ts.txt");
    expect(file("src/cron/send-digest.ts")!.mode).toBe("seed");
    await golden("src/cron/send-digest.ts", "send-digest.task.ts.txt");
  });

  it("leaves a project without them as it was", () => {
    const plain = strapiAdapter.generate(
      { document: hooksDoc, roles: [] },
      { projectName: "blog" },
    );
    const paths = plain.files.map((f) => f.path);
    expect(paths).not.toContain("config/cron-tasks.ts");
    expect(
      paths.some((p) => p.startsWith("src/policies/") || p.startsWith("src/middlewares/")),
    ).toBe(false);
    expect(plain.files.find((f) => f.path === "config/server.ts")!.content).not.toContain("cron");
  });
});
