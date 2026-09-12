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
      content("database/migrations/0001_01_02_000002_create_articles_table.php"),
    ).toMatchFileSnapshot("./__golden__/catalog/create_articles_table.php");
  });
  // Article.author is a manyToOne to Author: the authors migration must run before articles'
  // so `->constrained('authors')` resolves. Author has no dependency of its own, so it is
  // ordered first even though Article comes first in the IR.
  it("orders create-table migrations by foreign-key dependency, not IR position", () => {
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("database/migrations/0001_01_02_000001_create_authors_table.php");
    expect(paths).toContain("database/migrations/0001_01_02_000002_create_articles_table.php");
    expect(paths).toContain("database/migrations/0001_01_02_000003_create_tags_table.php");
    expect(content("database/migrations/0001_01_02_000002_create_articles_table.php")).toContain(
      "->constrained('authors')",
    );
  });
  it("pivot migration golden", async () => {
    await expect(
      content("database/migrations/0001_01_02_000004_create_article_tag_table.php"),
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
