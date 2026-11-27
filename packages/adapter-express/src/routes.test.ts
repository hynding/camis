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
  it("emits a marked CRUD router awaiting each query", () => {
    expect(ts).toContain("@camis:generated");
    expect(ts).toContain("export const articlesRouter = Router();");
    expect(ts).toContain("await db.select().from(articles).orderBy(asc(articles.id))");
    expect(ts).toContain(
      "const [{ id }] = await db.insert(articles).values(data).returning({ id: articles.id });",
    );
    expect(ts).toContain('const data = pick(req.body, ["title", "published"]);');
    expect(ts).toContain("await db.delete(articles).where(eq(articles.id, id));");
  });

  it("includes FK columns in the insertable pick-list", () => {
    const ts = emitRoutes(article, ["author_id"]);
    expect(ts).toContain('pick(req.body, ["title", "published", "author_id"]);');
  });

  it("unsecured routes are unchanged (no guard imports)", () => {
    const ts = emitRoutes(article, []);
    expect(ts).not.toContain("authorizeAction");
  });

  it("secured routes import guards, gate actions, filter reads, and return {id} on delete", () => {
    const ts = emitRoutes(article, [], { secured: true });
    expect(ts).toContain(
      '  recordAllowed,\n  roleOf,\n  sortColumn,\n  stripWrites,\n} from "../permissions/enforce";',
    );
    expect(ts).toContain('authorizeAction(roleOf(req), "Article", "read")');
    expect(ts).toContain("filterRead(req,");
    expect(ts).toContain("res.json({ id });");
    expect(ts).toContain('res.setHeader("Content-Range"');
  });

  it("without aiColumns, output is unchanged (no populate import)", () => {
    expect(emitRoutes(article, [])).not.toContain("populateAiFields");
  });
  it("with aiColumns, excludes them from the pick-list and weaves async populate", () => {
    const ts = emitRoutes(article, [], { aiColumns: ["summary"] });
    expect(ts).toContain('import { populateAiFields } from "../ai/populate";');
    expect(ts).toContain('Router.post("/", asyncRoute(async (req, res) =>');
    expect(ts).toContain('data = await populateAiFields("Article", data, "create");');
    expect(ts).toContain('data = await populateAiFields("Article", data, "update");');
    expect(ts).not.toContain('"summary"');
  });

  describe("secured writes and reads", () => {
    const ts = emitRoutes(article, ["owner_id"], { secured: true });
    it("checks each action's own record condition", () => {
      expect(ts).toContain('recordAllowed(req, "Article", "read", row)');
      expect(ts).toContain('recordAllowed(req, "Article", "update", existing)');
      expect(ts).toContain('recordAllowed(req, "Article", "delete", existing)');
    });
    it("fills assigned owners from the user and holds a create to the create condition", () => {
      expect(ts).toContain(
        'const data = assignOwners(req, "Article", stripWrites(req, "Article", proposed, proposed));',
      );
      expect(ts).toContain('if (!recordAllowed(req, "Article", "create", data)) {');
    });
    it("never lets an update move an assigned owner, and checks the row it would leave", () => {
      expect(ts).toContain(
        'const incoming = keepOwners(req, "Article", pick(req.body, ["title", "published", "owner_id"]));',
      );
      expect(ts).toContain(
        'if (!recordAllowed(req, "Article", "update", { ...existing, ...data })) {',
      );
    });
    it("sorts only by a column the caller may read", () => {
      expect(ts).toContain('const sort = sortColumn(req, "Article", req.query._sort);');
    });
  });
});
