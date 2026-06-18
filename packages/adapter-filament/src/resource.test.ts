import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitResourceFiles } from "./resource";

const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "string", name: "title", required: true },
    { type: "boolean", name: "published" },
  ],
} as ContentType;

describe("emitResourceFiles", () => {
  const files = emitResourceFiles(article);
  const byPath = (p: string) => files.find((f) => f.path === p)!.content;

  it("emits resource, form, table, and three pages at v5 paths", () => {
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual([
      "app/Filament/Resources/Articles/ArticleResource.php",
      "app/Filament/Resources/Articles/Pages/CreateArticle.php",
      "app/Filament/Resources/Articles/Pages/EditArticle.php",
      "app/Filament/Resources/Articles/Pages/ListArticles.php",
      "app/Filament/Resources/Articles/Schemas/ArticleForm.php",
      "app/Filament/Resources/Articles/Schemas/ArticlesTable.php",
    ]);
  });
  it("resource wires model, form, table, pages", () => {
    const r = byPath("app/Filament/Resources/Articles/ArticleResource.php");
    expect(r).toContain("protected static ?string $model = Article::class;");
    expect(r).toContain("return ArticleForm::configure($schema);");
    expect(r).toContain("return ArticlesTable::configure($table);");
    expect(r).toContain("'index' => ListArticles::route('/'),");
  });
  it("form lists required component, table lists columns", () => {
    expect(byPath("app/Filament/Resources/Articles/Schemas/ArticleForm.php")).toContain(
      "TextInput::make('title')->required(),",
    );
    expect(byPath("app/Filament/Resources/Articles/Schemas/ArticlesTable.php")).toContain(
      "IconColumn::make('published')->boolean(),",
    );
  });
});
