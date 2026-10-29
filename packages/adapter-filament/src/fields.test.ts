import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { emitField, isSupportedField } from "./fields";

describe("emitField", () => {
  it("maps a required string", () => {
    const f = emitField({ type: "string", name: "title", required: true } as Field);
    expect(f.column).toBe("title");
    expect(f.migration).toBe("$table->string('title')");
    expect(f.formComponent).toBe("TextInput::make('title')->required()");
    expect(f.tableColumn).toBe("TextColumn::make('title')");
    expect(f.cast).toBeUndefined();
  });
  it("maps a boolean with a cast and icon column", () => {
    const f = emitField({ type: "boolean", name: "published" } as Field);
    expect(f.migration).toBe("$table->boolean('published')->nullable()");
    expect(f.tableColumn).toBe("IconColumn::make('published')->boolean()");
    expect(f.cast).toBe("'boolean'");
  });
  it("snake-cases the column from a camelCase field", () => {
    const f = emitField({ type: "dateTime", name: "publishedAt" } as Field);
    expect(f.column).toBe("published_at");
    expect(f.cast).toBe("'datetime'");
  });
  it("maps blocks to a JSON column, an array cast and the blocks editor", () => {
    const f = emitField({ type: "blocks", name: "body" } as Field);
    expect(f.migration).toBe("$table->json('body')->nullable()");
    expect(f.cast).toBe("'array'");
    expect(f.formComponent).toBe("BlocksEditor::make('body')");
    expect(f.formImport).toBe("App\\Filament\\Forms\\BlocksEditor");
    expect(f.tableColumn).toBe(
      "TextColumn::make('body')->state(fn ($record): string => \\App\\Support\\StrapiBlocks::plainText($record->body))->limit(50)",
    );
    expect(isSupportedField("blocks")).toBe(true);
  });
  it("isSupportedField gates the supported subset", () => {
    expect(isSupportedField("string")).toBe(true);
    expect(isSupportedField("relation")).toBe(false);
    expect(isSupportedField("component")).toBe(false);
  });
  it("maps enumeration to a Select with options and a string column", () => {
    const f = emitField({
      type: "enumeration",
      name: "status",
      values: ["draft", "published"],
    } as Field);
    expect(f.migration).toBe("$table->string('status')->nullable()");
    expect(f.formComponent).toBe(
      "Select::make('status')->options(['draft' => 'draft', 'published' => 'published'])",
    );
  });
  it("applies required, unique, and default to the migration", () => {
    const f = emitField({
      type: "string",
      name: "slug",
      required: true,
      unique: true,
      default: "x",
    } as Field);
    expect(f.migration).toBe("$table->string('slug')->unique()->default('x')");
    expect(f.formComponent).toBe("TextInput::make('slug')->required()->unique()");
  });
  it("escapes quotes and backslashes in a string default (no codegen injection)", () => {
    const f = emitField({ type: "string", name: "tag", default: "a'b\\c" } as Field);
    expect(f.migration).toBe("$table->string('tag')->nullable()->default('a\\'b\\\\c')");
  });
  it("escapes enum values in Select options (no codegen injection)", () => {
    const f = emitField({ type: "enumeration", name: "kind", values: ["o'k"] } as Field);
    expect(f.formComponent).toBe("Select::make('kind')->options(['o\\'k' => 'o\\'k'])");
  });
  it("maps json/media/richText/decimal", () => {
    expect(emitField({ type: "json", name: "meta" } as Field).cast).toBe("'array'");
    expect(emitField({ type: "media", name: "cover", multiple: true } as Field).migration).toBe(
      "$table->json('cover')->nullable()",
    );
    expect(emitField({ type: "richText", name: "body" } as Field).formComponent).toBe(
      "MarkdownEditor::make('body')",
    );
    expect(emitField({ type: "decimal", name: "price" } as Field).cast).toBe("'decimal:2'");
  });
  // Strapi's richtext is Markdown: an HTML editor would rewrite it on the first save.
  it("edits richText as Markdown", () => {
    const f = emitField({ type: "richText", name: "body" } as Field);
    expect(f.formComponent).toBe("MarkdownEditor::make('body')");
    expect(f.formImport).toBe("Filament\\Forms\\Components\\MarkdownEditor");
  });
  // A key/value editor holds only a flat map of strings; JSON holds any value.
  it("edits json as JSON text, keeping nested values, arrays, numbers and booleans", () => {
    const f = emitField({ type: "json", name: "meta" } as Field);
    expect(f.formComponent).toBe("JsonEditor::make('meta')");
    expect(f.formImport).toBe("App\\Filament\\Forms\\JsonEditor");
    expect(f.cast).toBe("'array'");
  });
  it("checks a pattern in the admin form, as a PCRE whose delimiter cannot clash", () => {
    expect(
      emitField({ type: "string", name: "code", pattern: "^[A-Z]{3}$" } as Field).formComponent,
    ).toBe("TextInput::make('code')->regex('~^[A-Z]{3}$~')");
    expect(
      emitField({ type: "text", name: "path", pattern: "^a~b\\~c/d'$" } as Field).formComponent,
    ).toBe("Textarea::make('path')->regex('~^a\\\\~b\\\\~c/d\\'$~')");
  });
});
