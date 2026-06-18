import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import {
  emitMigration,
  emitPivotMigration,
  migrationFilename,
  pivotMigrationFilename,
} from "./migration";

const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "string", name: "title", required: true },
    { type: "text", name: "body" },
    { type: "boolean", name: "published" },
  ],
} as ContentType;

describe("migration", () => {
  it("emits a create migration with portable columns and nullability", () => {
    const php = emitMigration(article);
    expect(php).toContain("Schema::create('articles', function (Blueprint $table): void {");
    expect(php).toContain("$table->id();");
    expect(php).toContain("$table->string('title');");
    expect(php).toContain("$table->text('body')->nullable();");
    expect(php).toContain("$table->boolean('published')->nullable();");
    expect(php).toContain("$table->timestamps();");
    expect(php).toContain("Schema::dropIfExists('articles');");
  });
  it("uses a deterministic ordinal filename (no timestamp)", () => {
    expect(migrationFilename(article, 1)).toBe(
      "database/migrations/0000_00_00_000001_create_articles_table.php",
    );
    expect(migrationFilename(article, 2)).toBe(
      "database/migrations/0000_00_00_000002_create_articles_table.php",
    );
  });
  it("appends injected FK columns to a create migration", () => {
    const php = emitMigration(article, [
      "$table->foreignId('author_id')->nullable()->constrained('authors')",
    ]);
    expect(php).toContain("$table->foreignId('author_id')->nullable()->constrained('authors');");
  });
  it("emits a pivot table migration", () => {
    const pivot = {
      table: "article_tag",
      leftTable: "articles",
      rightTable: "tags",
      leftFk: "article_id",
      rightFk: "tag_id",
    };
    expect(pivotMigrationFilename(pivot, 5)).toBe(
      "database/migrations/0000_00_00_000005_create_article_tag_table.php",
    );
    const php = emitPivotMigration(pivot);
    expect(php).toContain("Schema::create('article_tag', function (Blueprint $table): void {");
    expect(php).toContain(
      "$table->foreignId('article_id')->constrained('articles')->cascadeOnDelete();",
    );
    expect(php).toContain("$table->foreignId('tag_id')->constrained('tags')->cascadeOnDelete();");
  });
});
