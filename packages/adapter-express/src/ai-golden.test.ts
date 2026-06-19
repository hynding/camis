import { describe, expect, it } from "vitest";
import { expressAdapter } from "./generate";
import { aiFixture } from "./__fixtures__/ai";

describe("ai golden", () => {
  const result = expressAdapter.generate(aiFixture, { projectName: "blog" });
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("articles routes golden (async populate, summary excluded from pick-list)", async () => {
    await expect(c("src/routes/articles.ts")).toMatchFileSnapshot(
      "./__golden__/ai/articles.routes.ts.txt",
    );
  });
  it("provider seam golden (seed)", async () => {
    await expect(c("src/ai/provider.ts")).toMatchFileSnapshot("./__golden__/ai/provider.ts.txt");
  });
  it("populate module golden", async () => {
    await expect(c("src/ai/populate.ts")).toMatchFileSnapshot("./__golden__/ai/populate.ts.txt");
  });
  it("file-listing golden", async () => {
    await expect(
      result.files
        .map((f) => `${f.mode ?? "overwrite"} ${f.path}`)
        .sort()
        .join("\n"),
    ).toMatchFileSnapshot("./__golden__/ai/file-listing.txt");
  });
  it("is idempotent", () => {
    expect(expressAdapter.generate(aiFixture, { projectName: "blog" })).toEqual(result);
  });
});
