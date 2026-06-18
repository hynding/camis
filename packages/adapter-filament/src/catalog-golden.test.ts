import { describe, expect, it } from "vitest";
import { filamentAdapter } from "./generate";
import { catalog } from "./__fixtures__/catalog";

describe("catalog golden", () => {
  const result = filamentAdapter.generate(catalog, { projectName: "blog" });
  const content = (p: string) => result.files.find((f) => f.path === p)!.content;

  it("Article model golden", async () => {
    await expect(content("app/Models/Article.php")).toMatchFileSnapshot(
      "./__golden__/catalog/Article.model.php",
    );
  });
  it("Author model golden", async () => {
    await expect(content("app/Models/Author.php")).toMatchFileSnapshot(
      "./__golden__/catalog/Author.model.php",
    );
  });
  it("articles migration golden", async () => {
    await expect(
      content("database/migrations/0000_00_00_000001_create_articles_table.php"),
    ).toMatchFileSnapshot("./__golden__/catalog/create_articles_table.php");
  });
  it("pivot migration golden", async () => {
    await expect(
      content("database/migrations/0000_00_00_000004_create_article_tag_table.php"),
    ).toMatchFileSnapshot("./__golden__/catalog/create_article_tag_table.php");
  });
  it("Article form golden", async () => {
    await expect(
      content("app/Filament/Resources/Articles/Schemas/ArticleForm.php"),
    ).toMatchFileSnapshot("./__golden__/catalog/ArticleForm.php");
  });
  it("file listing golden", async () => {
    await expect(
      result.files
        .map((f) => `${f.mode ?? "overwrite"} ${f.path}`)
        .sort()
        .join("\n"),
    ).toMatchFileSnapshot("./__golden__/catalog/file-listing.txt");
  });
  it("gap report is empty (no component/dynamicZone in fixture)", () => {
    expect(result.gaps.gaps).toEqual([]);
  });
  it("regeneration is idempotent", () => {
    expect(filamentAdapter.generate(catalog, { projectName: "blog" })).toEqual(result);
  });
});
