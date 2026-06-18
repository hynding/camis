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
  it("maps json/media/richText/decimal", () => {
    expect(emitField({ type: "json", name: "meta" } as Field).cast).toBe("'array'");
    expect(emitField({ type: "media", name: "cover", multiple: true } as Field).migration).toBe(
      "$table->json('cover')->nullable()",
    );
    expect(emitField({ type: "richText", name: "body" } as Field).formComponent).toBe(
      "RichEditor::make('body')",
    );
    expect(emitField({ type: "decimal", name: "price" } as Field).cast).toBe("'decimal:2'");
  });
});
