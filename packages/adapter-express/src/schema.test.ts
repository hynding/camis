import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitSchema } from "./schema";

const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "string", name: "title", required: true },
    { type: "boolean", name: "published" },
  ],
} as ContentType;

describe("emitSchema", () => {
  const ts = emitSchema(article);
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
