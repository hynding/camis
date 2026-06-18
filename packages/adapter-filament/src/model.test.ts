import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitModel } from "./model";

const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "string", name: "title", required: true },
    { type: "boolean", name: "published" },
    { type: "dateTime", name: "publishedAt" },
  ],
} as ContentType;

describe("emitModel", () => {
  it("emits an Eloquent model with table, fillable, and casts()", () => {
    const php = emitModel(article);
    expect(php).toContain("namespace App\\Models;");
    expect(php).toContain("class Article extends Model");
    expect(php).toContain("protected $table = 'articles';");
    expect(php).toContain("'title',");
    expect(php).toContain("'published_at',");
    expect(php).toContain("protected function casts(): array");
    expect(php).toContain("'published' => 'boolean',");
    expect(php).toContain("'published_at' => 'datetime',");
    expect(php.startsWith("<?php\n\ndeclare(strict_types=1);")).toBe(true);
  });

  it("emits injected relationship methods and their imports", () => {
    const php = emitModel(article, [
      {
        import: "Illuminate\\Database\\Eloquent\\Relations\\BelongsTo",
        php: "    public function author(): BelongsTo\n    {\n        return $this->belongsTo(Author::class, 'author_id');\n    }",
      },
    ]);
    expect(php).toContain("use Illuminate\\Database\\Eloquent\\Relations\\BelongsTo;");
    expect(php).toContain("public function author(): BelongsTo");
  });

  it("adds the ObservedBy attribute and observer use when observed", () => {
    const php = emitModel(article, [], true);
    expect(php).toContain("use App\\Observers\\ArticleObserver;");
    expect(php).toContain(
      "#[\\Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy([ArticleObserver::class])]",
    );
    expect(php).toContain("class Article extends Model");
  });
});
