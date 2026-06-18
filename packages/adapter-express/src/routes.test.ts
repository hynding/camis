import { describe, expect, it } from "vitest";
import type { ContentType } from "@camis/ir-schema";
import { emitRoutes } from "./routes";

const article: ContentType = {
  name: "Article",
  kind: "collection",
  fields: [
    { type: "string", name: "title" },
    { type: "boolean", name: "published" },
  ],
} as ContentType;

describe("emitRoutes", () => {
  const ts = emitRoutes(article, []);
  it("emits a marked CRUD router using sync better-sqlite3 calls", () => {
    expect(ts).toContain("@camis:generated");
    expect(ts).toContain("export const articlesRouter = Router();");
    expect(ts).toContain("db.select().from(articles).all()");
    expect(ts).toContain("db.insert(articles).values(data).returning().get()");
    expect(ts).toContain('const data = pick(req.body, ["title", "published"]);');
    expect(ts).toContain(
      "db.delete(articles).where(eq(articles.id, Number(req.params.id))).run();",
    );
  });

  it("includes FK columns in the insertable pick-list", () => {
    const ts = emitRoutes(article, ["author_id"]);
    expect(ts).toContain('pick(req.body, ["title", "published", "author_id"]);');
  });
});
