import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { hooksBundle } from "../__fixtures__/hooks";

describe("filament hooks golden", () => {
  const result = filamentAdapter.generate(hooksBundle, { projectName: "blog" });
  const c = (p: string) => result.files.find((f) => f.path === p)!.content;
  it("contract golden", async () => {
    await expect(c("app/Hooks/Contracts/TransformTitleHook.php")).toMatchFileSnapshot(
      "./__golden__/TransformTitleHook.php",
    );
  });
  it("stub golden (seed)", async () => {
    const s = result.files.find((f) => f.path === "app/Hooks/TransformTitle.php")!;
    expect(s.mode).toBe("seed");
    await expect(s.content).toMatchFileSnapshot("./__golden__/TransformTitle.stub.php");
  });
  it("observer golden", async () => {
    await expect(c("app/Observers/ArticleObserver.php")).toMatchFileSnapshot(
      "./__golden__/ArticleObserver.php",
    );
  });
  it("model carries ObservedBy", async () => {
    await expect(c("app/Models/Article.php")).toMatchFileSnapshot(
      "./__golden__/Article.observed.php",
    );
  });
  it("idempotent", () => {
    expect(filamentAdapter.generate(hooksBundle, { projectName: "blog" })).toEqual(result);
  });
});
