import { describe, expect, it } from "vitest";
import { aiFixture } from "./__fixtures__/ai";
import { filamentAdapter } from "./generate";

describe("filament ai golden", () => {
  const result = filamentAdapter.generate(aiFixture, { projectName: "blog" });
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("observer golden", async () => {
    await expect(c("app/Observers/ArticleObserver.php")).toMatchFileSnapshot(
      "./__golden__/ai/ArticleObserver.php.txt",
    );
  });
  it("provider golden (seed)", async () => {
    await expect(c("app/Ai/Provider.php")).toMatchFileSnapshot("./__golden__/ai/Provider.php.txt");
  });
  it("marks the Article model observed", () => {
    expect(c("app/Models/Article.php")).toContain("ObservedBy([ArticleObserver::class])");
  });
  it("is idempotent", () => {
    expect(filamentAdapter.generate(aiFixture, { projectName: "blog" })).toEqual(result);
  });
});
