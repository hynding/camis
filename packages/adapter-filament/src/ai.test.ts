import { describe, expect, it } from "vitest";
import type { ContentType, IrDocument } from "@camis/ir-schema";
import { aiFieldContentTypes, aiProviderFile, emitAiObserver, hasAiField } from "./ai";

const ct: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "text", name: "body" },
    {
      type: "text",
      name: "summary",
      ai: { prompt: "Summarize: {{body}}", trigger: "onCreateOrUpdate" },
    },
  ],
} as ContentType;
const doc: IrDocument = { version: 1, contentTypes: [ct], components: [] } as IrDocument;

describe("filament ai emitter", () => {
  it("detects AI content types", () => {
    expect(hasAiField(doc)).toBe(true);
    expect(aiFieldContentTypes(doc).map((c) => c.name)).toEqual(["Article"]);
  });
  it("emits a protected PHP provider seed", () => {
    const f = aiProviderFile();
    expect(f.path).toBe("app/Ai/Provider.php");
    expect(f.mode).toBe("seed");
    expect(f.content).toContain("namespace App\\Ai;");
    expect(f.content).toContain(
      "public static function generate(?string $model, string $prompt): string",
    );
    expect(f.content).toContain("ANTHROPIC_API_KEY");
  });
  it("emits an observer that populates on creating/updating with isDirty + escaped prompt", () => {
    const php = emitAiObserver(ct);
    expect(php).toContain("class ArticleObserver");
    expect(php).toContain("public function creating(Article $record): void");
    expect(php).toContain("public function updating(Article $record): void");
    expect(php).toContain("$isCreate || ($record->isDirty('body'))");
    expect(php).toContain(
      "str_replace(['{{body}}'], [(string) $record->body], 'Summarize: {{body}}')",
    );
    expect(php).toContain("$record->summary = Provider::generate(null, $prompt);");
  });
});
