import { describe, expect, it } from "vitest";
import { strapiAdapter } from "./generate";
import { aiFixture } from "./__fixtures__/ai";

describe("strapi ai golden", () => {
  const result = strapiAdapter.generate(
    { document: aiFixture, roles: [] },
    { projectName: "blog" },
  );
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("lifecycle golden", async () => {
    await expect(c("src/api/article/content-types/article/lifecycles.ts")).toMatchFileSnapshot(
      "./__golden__/ai/lifecycles.ts.txt",
    );
  });
  it("provider golden (seed)", async () => {
    await expect(c("src/ai/provider.ts")).toMatchFileSnapshot("./__golden__/ai/provider.ts.txt");
  });
  it("emits both AI files", () => {
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("src/ai/provider.ts");
    expect(paths).toContain("src/api/article/content-types/article/lifecycles.ts");
  });
  it("is idempotent", () => {
    expect(
      strapiAdapter.generate({ document: aiFixture, roles: [] }, { projectName: "blog" }),
    ).toEqual(result);
  });
});
