import { describe, expect, it } from "vitest";
import { filamentAdapter } from "./generate";
import { blog } from "./__fixtures__/blog";

describe("filament golden", () => {
  const result = filamentAdapter.generate(blog, { projectName: "blog" });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("model golden", async () => {
    await expect(content("app/Models/Article.php")).toMatchFileSnapshot(
      "./__golden__/Article.model.php",
    );
  });
  it("migration golden", async () => {
    await expect(
      content("database/migrations/0000_00_00_000001_create_articles_table.php"),
    ).toMatchFileSnapshot("./__golden__/create_articles_table.php");
  });
  it("resource golden", async () => {
    await expect(
      content("app/Filament/Resources/Articles/ArticleResource.php"),
    ).toMatchFileSnapshot("./__golden__/ArticleResource.php");
  });
  it("form golden", async () => {
    await expect(
      content("app/Filament/Resources/Articles/Schemas/ArticleForm.php"),
    ).toMatchFileSnapshot("./__golden__/ArticleForm.php");
  });
  it("table golden", async () => {
    await expect(
      content("app/Filament/Resources/Articles/Schemas/ArticlesTable.php"),
    ).toMatchFileSnapshot("./__golden__/ArticlesTable.php");
  });
  it("file listing golden", async () => {
    const listing = result.files
      .map((f) => `${f.mode ?? "overwrite"} ${f.path}`)
      .sort()
      .join("\n");
    await expect(listing).toMatchFileSnapshot("./__golden__/file-listing.txt");
  });
  it("regeneration is idempotent", () => {
    expect(filamentAdapter.generate(blog, { projectName: "blog" })).toEqual(result);
  });
});
