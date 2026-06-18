import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { emitField, isScalar6A } from "./fields";

describe("emitField", () => {
  it("maps a required string", () => {
    const f = emitField({ type: "string", name: "title", required: true } as Field);
    expect(f.column).toBe("title");
    expect(f.required).toBe(true);
    expect(f.migration).toBe("$table->string('title')");
    expect(f.formComponent).toBe("TextInput::make('title')");
    expect(f.tableColumn).toBe("TextColumn::make('title')");
    expect(f.cast).toBeUndefined();
  });
  it("maps a boolean with a cast and icon column", () => {
    const f = emitField({ type: "boolean", name: "published" } as Field);
    expect(f.migration).toBe("$table->boolean('published')");
    expect(f.tableColumn).toBe("IconColumn::make('published')->boolean()");
    expect(f.cast).toBe("'boolean'");
  });
  it("snake-cases the column from a camelCase field", () => {
    const f = emitField({ type: "dateTime", name: "publishedAt" } as Field);
    expect(f.column).toBe("published_at");
    expect(f.cast).toBe("'datetime'");
  });
  it("isScalar6A gates the supported subset", () => {
    expect(isScalar6A("string")).toBe(true);
    expect(isScalar6A("relation")).toBe(false);
  });
});
