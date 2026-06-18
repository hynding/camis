import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import type { ResolvedRelations } from "./relations";
import { emitSchemaFile } from "./schema";

const empty: ResolvedRelations = { fkColumns: new Map(), relationBlocks: new Map() };

const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "string", name: "title", required: true },
    { type: "boolean", name: "published" },
  ],
} as ContentType;

const author: ContentType = {
  name: "Author",
  kind: "collection",
  fields: [{ type: "string", name: "name" }],
} as ContentType;

describe("emitSchemaFile", () => {
  const ts = emitSchemaFile([article], "sqlite", empty);
  it("emits a marked sqliteTable with id, columns, and timestamps", () => {
    expect(ts).toContain("@camis:generated");
    expect(ts).toContain('import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";');
    expect(ts).toContain('export const articles = sqliteTable("articles", {');
    expect(ts).toContain('id: integer("id").primaryKey({ autoIncrement: true }),');
    expect(ts).toContain("title: text('title').notNull(),");
    expect(ts).toContain("published: integer('published', { mode: 'boolean' }),");
    expect(ts).toContain('createdAt: integer("created_at", { mode: "timestamp" }),');
  });
});

describe("emitSchemaFile (dialect-aware)", () => {
  it("pg uses pgTable + serial", () => {
    const ts = emitSchemaFile([article], "pgsql", empty);
    expect(ts).toContain('drizzle-orm/pg-core";');
    expect(ts).toContain("pgTable(");
    expect(ts).toContain('id: serial("id").primaryKey(),');
  });
  it("merges imports across multiple tables into a single import statement", () => {
    const ts = emitSchemaFile([article, author], "sqlite", empty);
    const coreImports = ts
      .split("\n")
      .filter((l) => l.startsWith("import { ") && l.includes("sqlite-core"));
    expect(coreImports.length).toBe(1);
    expect(ts).toContain('export const articles = sqliteTable("articles", {');
    expect(ts).toContain('export const authors = sqliteTable("authors", {');
  });
});
