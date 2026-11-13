import { describe, expect, it } from "vitest";
import { TS_MARKER } from "@camis/adapter-kernel";
import { strapiAdapter } from "../generate";
import { customCodeDoc } from "../__fixtures__/custom-code";

// An IR endpoint is Strapi's custom route, whose handler is a controller of its own.
describe("strapi endpoints", () => {
  const result = strapiAdapter.generate(
    {
      document: customCodeDoc,
      roles: [{ name: "Reader", grants: [], endpoints: ["ArticleLike"] }],
    },
    { projectName: "blog" },
  );
  const file = (p: string) => result.files.find((f) => f.path === p);

  it("declares a type's endpoints in a custom routes file ahead of its core router", async () => {
    const routes = file("src/api/article/routes/01-endpoints.ts")!;
    expect(routes.content.startsWith(TS_MARKER)).toBe(true);
    await expect(routes.content).toMatchFileSnapshot("./__golden__/article.endpoints.ts.txt");
  });

  it("seeds each endpoint's controller once, with its one action", async () => {
    const controller = file("src/api/article/controllers/article-like.ts")!;
    expect(controller.mode).toBe("seed");
    await expect(controller.content).toMatchFileSnapshot(
      "./__golden__/article-like.controller.ts.txt",
    );
  });

  it("lets a role that lists an endpoint call its handler", () => {
    const apiRoles = JSON.parse(file("src/permissions/api-roles.json")!.content);
    expect(apiRoles.roles).toEqual([
      { type: "Reader", actions: ["api::article.article-like.handle"] },
    ]);
  });

  it("writes no routes file for a type without endpoints", () => {
    expect(file("src/api/homepage/routes/01-endpoints.ts")).toBeUndefined();
  });
});
