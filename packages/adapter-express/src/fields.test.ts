import { describe, expect, it } from "vitest";
import type { Field } from "@camis/ir-schema";
import { column, isSupportedField } from "./fields";

describe("column (sqlite, 8A-compatible)", () => {
  it("required unique string", () => {
    expect(
      column("sqlite", { type: "string", name: "title", required: true, unique: true } as Field)
        .drizzle,
    ).toBe("text('title').notNull().unique()");
  });
  it("boolean + dateTime modes", () => {
    expect(column("sqlite", { type: "boolean", name: "published" } as Field).drizzle).toBe(
      "integer('published', { mode: 'boolean' })",
    );
    expect(column("sqlite", { type: "dateTime", name: "publishedAt" } as Field).drizzle).toBe(
      "integer('published_at', { mode: 'timestamp' })",
    );
  });
  it("escapes string default", () => {
    expect(
      column("sqlite", { type: "string", name: "tag", default: "a'b\\c" } as Field).drizzle,
    ).toBe("text('tag').default('a\\'b\\\\c')");
  });
});

describe("column (pg / mysql breadth)", () => {
  it("pg string→varchar, boolean→boolean, json→jsonb", () => {
    expect(column("pgsql", { type: "string", name: "title" } as Field).drizzle).toBe(
      "varchar('title', { length: 255 })",
    );
    expect(column("pgsql", { type: "boolean", name: "ok" } as Field).drizzle).toBe("boolean('ok')");
    expect(column("pgsql", { type: "json", name: "meta" } as Field).import).toBe("jsonb");
  });
  it("mysql integer→int, decimal→decimal", () => {
    expect(column("mysql", { type: "integer", name: "n" } as Field).drizzle).toBe("int('n')");
    expect(column("mysql", { type: "decimal", name: "p" } as Field).import).toBe("decimal");
  });
  it("isSupportedField covers the taxonomy, gaps relations/components", () => {
    expect(isSupportedField("json")).toBe(true);
    expect(isSupportedField("relation")).toBe(false);
    expect(isSupportedField("component")).toBe(false);
  });
});
