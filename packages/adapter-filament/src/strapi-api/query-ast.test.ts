import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { renderEloquent, renderSql, toWhereNode, whereContext } from "./query-ast";
import { strapiApiBundle } from "./__fixtures__/strapi-api";

const activity = strapiApiBundle.document.contentTypes.find((c) => c.name === "Activity")!;
const ctx = whereContext(activity);
const v = (name: string): Expression => ({ kind: "var", name });
const lit = (value: string | number | boolean | null): Expression => ({ kind: "lit", value });

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
