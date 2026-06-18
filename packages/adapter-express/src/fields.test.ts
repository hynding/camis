import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { emitColumn, isSupported8A } from "./fields";

describe("emitColumn", () => {
  it("maps a required unique string to text().notNull().unique()", () => {
    const c = emitColumn({ type: "string", name: "title", required: true, unique: true } as Field);
    expect(c.column).toBe("title");
    expect(c.drizzle).toBe("text('title').notNull().unique()");
    expect(c.import).toBe("text");
  });
  it("maps boolean and dateTime with modes", () => {
    expect(emitColumn({ type: "boolean", name: "published" } as Field).drizzle).toBe(
      "integer('published', { mode: 'boolean' })",
    );
    expect(emitColumn({ type: "dateTime", name: "publishedAt" } as Field).drizzle).toBe(
      "integer('published_at', { mode: 'timestamp' })",
    );
  });
  it("isSupported8A gates the subset", () => {
    expect(isSupported8A("string")).toBe(true);
    expect(isSupported8A("relation")).toBe(false);
  });
  it("escapes quotes and backslashes in a string default (no codegen injection)", () => {
    const c = emitColumn({ type: "string", name: "tag", default: "a'b\\c" } as Field);
    expect(c.drizzle).toBe("text('tag').default('a\\'b\\\\c')");
  });
});
