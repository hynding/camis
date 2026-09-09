import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import type { ContentType } from "@camis/ir-schema";
import { renderEloquent, renderSql, toWhereNode, whereContext, type WhereNode } from "./query-ast";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { storageBundle } from "./storage/__fixtures__/storage";

const activity = strapiApiBundle.document.contentTypes.find((c) => c.name === "Activity")!;
const ctx = whereContext(activity);
const v = (name: string): Expression => ({ kind: "var", name });
const lit = (value: string | number | boolean | null): Expression => ({ kind: "lit", value });

const note = storageBundle.document.contentTypes.find((c) => c.name === "Note")!;
const noteLink = { table: "notes_owner_lnk", local: "note_id", foreign: "user_id", owner: "notes" };

describe("toWhereNode", () => {
  it("compiles record.field == literal", () => {
    expect(
      toWhereNode({ kind: "eq", left: v("record.visibility"), right: lit("public") }, ctx),
    ).toEqual({
      kind: "eq",
      column: "visibility",
      value: { kind: "lit", value: "public" },
    });
  });
  it("compiles record.<relation>Id == user.id (either operand order)", () => {
    const n = { kind: "eq", column: "creator_id", value: { kind: "userId" } };
    expect(
      toWhereNode({ kind: "eq", left: v("record.creatorId"), right: v("user.id") }, ctx),
    ).toEqual(n);
    expect(
      toWhereNode({ kind: "eq", left: v("user.id"), right: v("record.creatorId") }, ctx),
    ).toEqual(n);
  });
  it("compiles or/and recursively", () => {
    const e: Expression = {
      kind: "or",
      args: [
        { kind: "eq", left: v("record.visibility"), right: lit("public") },
        { kind: "eq", left: v("record.creatorId"), right: v("user.id") },
      ],
    };
    expect(toWhereNode(e, ctx)?.kind).toBe("or");
  });
  it("returns null for ne, not, lt, record-vs-record, user.email, and type mismatches", () => {
    expect(
      toWhereNode({ kind: "ne", left: v("record.visibility"), right: lit("public") }, ctx),
    ).toBeNull();
    expect(
      toWhereNode(
        { kind: "not", arg: { kind: "eq", left: v("record.visibility"), right: lit("public") } },
        ctx,
      ),
    ).toBeNull();
    expect(toWhereNode({ kind: "lt", left: v("record.creatorId"), right: lit(3) }, ctx)).toBeNull();
    expect(
      toWhereNode({ kind: "eq", left: v("record.name"), right: v("record.visibility") }, ctx),
    ).toBeNull();
    expect(
      toWhereNode({ kind: "eq", left: v("record.name"), right: v("user.email") }, ctx),
    ).toBeNull();
    expect(
      toWhereNode({ kind: "eq", left: v("record.visibility"), right: lit(1) }, ctx),
    ).toBeNull();
  });
});

// A scalar `creatorId` and a manyToOne relation `creator` both claim the Ring 1 name
// `record.creatorId` but mean different columns. Silently letting one win compiles a condition
// against the wrong column — dropping the key instead makes toWhereNode return null, which takes
// the documented per-record policy fallback (with its listScopeFallback gap).
describe("whereContext key collisions", () => {
  const colliding: ContentType = {
    name: "Thing",
    kind: "collection",
    fields: [
      { type: "string", name: "creatorId" },
      { type: "relation", name: "creator", relationKind: "manyToOne", target: "User" },
    ],
  };
  it("drops a key claimed by both a scalar and a relation rather than picking a winner", () => {
    const c = whereContext(colliding);
    expect(c.columns.has("record.creatorId")).toBe(false);
    expect(
      toWhereNode({ kind: "eq", left: v("record.creatorId"), right: v("user.id") }, c),
    ).toBeNull();
  });
  it("leaves non-colliding keys intact", () => {
    const c = whereContext(colliding);
    expect(whereContext(activity).columns.get("record.creatorId")?.column).toBe("creator_id");
    expect(c.columns.size).toBe(0);
  });
});

describe("whereContext storage layout", () => {
  it("carries link metadata for owning relations in the strapi layout", () => {
    const strapiCtx = whereContext(note, "strapi");
    expect(strapiCtx.columns.get("record.ownerId")).toEqual({
      column: "owner_id",
      type: "integer",
      link: noteLink,
    });
  });
  it("omits link metadata in the (default) laravel layout", () => {
    const laravelCtx = whereContext(note);
    expect(laravelCtx.columns.get("record.ownerId")).toEqual({
      column: "owner_id",
      type: "integer",
    });
    expect(laravelCtx.columns.get("record.ownerId")).not.toHaveProperty("link");
  });
});

describe("toWhereNode with link metadata", () => {
  it("copies link onto the compiled eq node", () => {
    const strapiCtx = whereContext(note, "strapi");
    const n = toWhereNode(
      { kind: "eq", left: v("record.ownerId"), right: v("user.id") },
      strapiCtx,
    );
    expect(n).toEqual({
      kind: "eq",
      column: "owner_id",
      value: { kind: "userId" },
      link: noteLink,
    });
  });
  it("returns null for a string literal against a link key (not expressible as an integer FK)", () => {
    const strapiCtx = whereContext(note, "strapi");
    expect(
      toWhereNode({ kind: "eq", left: v("record.ownerId"), right: lit("abc") }, strapiCtx),
    ).toBeNull();
  });
});

describe("renderers over link metadata (strapi layout)", () => {
  const strapiCtx = whereContext(note, "strapi");
  it("renderEloquent emits whereExists for record.ownerId == user.id", () => {
    const n = toWhereNode(
      { kind: "eq", left: v("record.ownerId"), right: v("user.id") },
      strapiCtx,
    )!;
    expect(renderEloquent(n, "$q", "$user")).toBe(
      "$q->whereExists(function ($s) use ($user) { $s->selectRaw('1')->from('notes_owner_lnk')->whereColumn('notes_owner_lnk.note_id', 'notes.id')->where('notes_owner_lnk.user_id', $user->id); });",
    );
  });
  it("renderSql emits an EXISTS subquery for record.ownerId == user.id", () => {
    const n = toWhereNode(
      { kind: "eq", left: v("record.ownerId"), right: v("user.id") },
      strapiCtx,
    )!;
    expect(renderSql(n, 7)).toBe(
      "EXISTS (SELECT 1 FROM notes_owner_lnk WHERE notes_owner_lnk.note_id = notes.id AND notes_owner_lnk.user_id = 7)",
    );
  });
  it("renderEloquent emits whereNotExists for record.ownerId == null", () => {
    const n = toWhereNode({ kind: "eq", left: v("record.ownerId"), right: lit(null) }, strapiCtx)!;
    expect(renderEloquent(n, "$q", "$user")).toBe(
      "$q->whereNotExists(function ($s) use ($user) { $s->selectRaw('1')->from('notes_owner_lnk')->whereColumn('notes_owner_lnk.note_id', 'notes.id'); });",
    );
  });
  it("renderSql emits NOT EXISTS for record.ownerId == null", () => {
    const n = toWhereNode({ kind: "eq", left: v("record.ownerId"), right: lit(null) }, strapiCtx)!;
    expect(renderSql(n, 1)).toBe(
      "NOT EXISTS (SELECT 1 FROM notes_owner_lnk WHERE notes_owner_lnk.note_id = notes.id)",
    );
  });
  it("renderEloquent emits orWhereExists at an or position alongside a scalar predicate", () => {
    const e: Expression = {
      kind: "or",
      args: [
        { kind: "eq", left: v("record.text"), right: lit("hello") },
        { kind: "eq", left: v("record.ownerId"), right: v("user.id") },
      ],
    };
    const n = toWhereNode(e, strapiCtx)!;
    expect(renderEloquent(n, "$q", "$user")).toBe(
      "$q->where(function ($q) use ($user) { $q->where('text', '=', 'hello'); $q->orWhereExists(function ($s) use ($user) { $s->selectRaw('1')->from('notes_owner_lnk')->whereColumn('notes_owner_lnk.note_id', 'notes.id')->where('notes_owner_lnk.user_id', $user->id); }); });",
    );
  });
});

describe("renderers", () => {
  const node = toWhereNode(
    {
      kind: "or",
      args: [
        { kind: "eq", left: v("record.visibility"), right: lit("public") },
        { kind: "eq", left: v("record.creatorId"), right: v("user.id") },
      ],
    },
    ctx,
  )!;
  it("renderEloquent nests closures", () => {
    expect(renderEloquent(node, "$q", "$user")).toBe(
      "$q->where(function ($q) use ($user) { $q->where('visibility', '=', 'public'); $q->orWhere('creator_id', '=', $user->id); });",
    );
  });
  it("renderSql produces a parenthesized WHERE body", () => {
    expect(renderSql(node, 7)).toBe("((visibility = 'public') OR (creator_id = 7))");
  });
  it("null literals render as IS NULL", () => {
    const n = toWhereNode({ kind: "eq", left: v("record.name"), right: lit(null) }, ctx)!;
    expect(renderEloquent(n, "$q", "$user")).toBe("$q->whereNull('name');");
    expect(renderSql(n, 1)).toBe("(name IS NULL)");
  });
});

// Column, table and link-column names all come from the IR, which a human or the AI authoring
// path writes. Interpolated raw, a name carrying a single quote closes the PHP literal early and
// the remainder of the name becomes PHP source.
describe("renderEloquent escapes author-controlled names", () => {
  it("escapes a quote in a plain column name and in a string literal", () => {
    const n: WhereNode = {
      kind: "eq",
      column: "o'brien",
      value: { kind: "lit", value: "it's" },
    };
    expect(renderEloquent(n, "$q", "$user")).toBe("$q->where('o\\'brien', '=', 'it\\'s');");
  });

  it("escapes a quote in a null column name", () => {
    const n: WhereNode = { kind: "eq", column: "o'brien", value: { kind: "lit", value: null } };
    expect(renderEloquent(n, "$q", "$user")).toBe("$q->whereNull('o\\'brien');");
  });

  it("escapes quotes in every link-table and link-column name", () => {
    const n: WhereNode = {
      kind: "eq",
      column: "owner_id",
      value: { kind: "userId" },
      link: { table: "a'a", local: "b'b", foreign: "c'c", owner: "d'd" },
    };
    const php = renderEloquent(n, "$q", "$user");
    expect(php).toContain("->from('a\\'a')");
    expect(php).toContain("->whereColumn('a\\'a.b\\'b', 'd\\'d.id')");
    expect(php).toContain("->where('a\\'a.c\\'c', $user->id)");
    expect(php).not.toContain("'a'a");
  });
});
