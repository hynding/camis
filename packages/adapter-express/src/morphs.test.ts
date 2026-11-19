import { describe, expect, it } from "vitest";
import { morphs } from "./__fixtures__/morphs";
import { expressAdapter, expressAdapterFor } from "./generate";

// Polymorphic links on the Express target: a to-one keeps its entry's type and id on the row, a
// to-many a link table; the routes read and write both as { type, id } and read the inverses.
// The boot smoke's sqlite leg drives them over HTTP.
describe("polymorphic relations on the Express target", () => {
  const result = expressAdapter.generate(morphs, { projectName: "notes" });
  const content = (path: string) => result.files.find((f) => f.path === path)?.content ?? "";

  it("serves them rather than reporting them", () => {
    expect(result.gaps.gaps.filter((g) => /^polymorphic/.test(g.feature))).toEqual([]);
  });

  it("keeps a to-one's type and id on the row and a to-many's links in a table of their own", async () => {
    const schema = content("src/db/schema.ts");
    expect(schema).toContain(
      "  pinned_to_id: integer('pinned_to_id'),\n  pinned_to_type: text('pinned_to_type'),",
    );
    expect(schema).toContain('export const notes_subjects = sqliteTable("notes_subjects", {');
    expect(schema).toContain("  note_id: integer('note_id').notNull().references(() => notes.id),");
    await expect(schema).toMatchFileSnapshot("./__golden__/morphs/schema.ts.txt");
  });

  it("reads, checks, writes and drops the links on each route that has them", () => {
    const notes = content("src/routes/notes.ts");
    for (const call of ["checkLinks(", "linkColumns(", "writeLinks(", "readLinks(", "dropLinks("])
      expect(notes, call).toContain(call);
    expect(content("src/routes/books.ts")).toContain("readLinks(");
    expect(content("src/routes/secrets.ts")).not.toContain("../morphs");
  });

  it("names every type a link may hold and each type's links", async () => {
    await expect(content("src/morphs.ts")).toMatchFileSnapshot("./__golden__/morphs/morphs.ts.txt");
    await expect(content("src/routes/notes.ts")).toMatchFileSnapshot(
      "./__golden__/morphs/notes.routes.ts.txt",
    );
  });

  it("lays the columns out for every dialect", () => {
    expect(
      expressAdapterFor("pgsql")
        .generate(morphs, { projectName: "notes" })
        .files.find((f) => f.path === "src/db/schema.ts")!.content,
    ).toContain("  pinned_to_type: varchar('pinned_to_type', { length: 255 }),");
  });
});
