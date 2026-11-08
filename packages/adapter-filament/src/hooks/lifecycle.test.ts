import { describe, expect, it } from "vitest";
import { filamentAdapter } from "../generate";
import { lifecycleHooksBundle } from "../__fixtures__/lifecycle-hooks";

describe("filament lifecycle hooks", () => {
  const result = filamentAdapter.generate(lifecycleHooksBundle, { projectName: "blog" });
  const file = (p: string) => result.files.find((f) => f.path === p);

  it("runs every hook of a content type from its one observer", async () => {
    await expect(file("app/Observers/ArticleObserver.php")!.content).toMatchFileSnapshot(
      "./__golden__/ArticleObserver.lifecycle.php",
    );
  });

  it("seeds a stub for each hook, returning nothing where the record cannot change", async () => {
    const stub = file("app/Hooks/AnnounceArticle.php")!;
    expect(stub.mode).toBe("seed");
    await expect(stub.content).toMatchFileSnapshot("./__golden__/AnnounceArticle.stub.php");
    await expect(file("app/Hooks/Contracts/AnnounceArticleHook.php")!.content).toMatchFileSnapshot(
      "./__golden__/AnnounceArticleHook.php",
    );
  });

  it("is idempotent", () => {
    expect(filamentAdapter.generate(lifecycleHooksBundle, { projectName: "blog" })).toEqual(result);
  });
});
