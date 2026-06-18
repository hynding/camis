import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitMigration, migrationFilename } from "./migration";

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
});
