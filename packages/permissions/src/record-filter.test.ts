import { describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import type { ContentType, FieldType } from "@camis/ir-schema";
import { recordEquality, recordVariables, toRecordFilter, USER_VARIABLES } from "./record-filter";

const v = (name: string): Expression => ({ kind: "var", name });
const lit = (value: string | number | boolean | null): Expression => ({ kind: "lit", value });
const eq = (left: Expression, right: Expression): Expression => ({ kind: "eq", left, right });

const note: ContentType = {
  name: "Note",
  kind: "collection",
  fields: [
    { type: "string", name: "title" },
    { type: "integer", name: "rank" },
    { type: "boolean", name: "pinned" },
    { type: "json", name: "extra" },
    { type: "media", name: "cover" },
    { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
    { type: "relation", name: "editors", relationKind: "manyToMany", target: "User" },
    { type: "relation", name: "profile", relationKind: "oneToOne", target: "Profile" },
  ],
} as ContentType;

const variables = recordVariables(note);
const typeOf = (name: string): FieldType | undefined => variables.get(name)?.type;
const everyUser = Object.keys(USER_VARIABLES);

describe("recordVariables", () => {
  it("names each scalar field record.<field> and each owning relation record.<relation>Id", () => {
    expect([...variables.keys()].sort()).toEqual([
      "record.ownerId",
      "record.pinned",
      "record.profileId",
      "record.rank",
      "record.title",
    ]);
    expect(variables.get("record.ownerId")).toEqual({
      field: "owner",
      relation: true,
      type: "integer",
    });
    expect(variables.get("record.title")).toEqual({
      field: "title",
      relation: false,
      type: "string",
    });
  });
  it("drops a name two fields claim, rather than let one silently win", () => {
    const contested = {
      ...note,
      fields: [
        { type: "integer", name: "ownerId" },
        { type: "relation", name: "owner", relationKind: "manyToOne", target: "User" },
      ],
    } as ContentType;
    expect(recordVariables(contested).has("record.ownerId")).toBe(false);
  });
});

describe("recordEquality", () => {
  it("takes record.<field> == literal in either operand order", () => {
    const expected = { variable: "record.title", value: { kind: "literal", value: "x" } };
    expect(recordEquality(eq(v("record.title"), lit("x")), typeOf, everyUser)).toEqual(expected);
    expect(recordEquality(eq(lit("x"), v("record.title")), typeOf, everyUser)).toEqual(expected);
  });
  it("takes record.<relation>Id == user.id", () => {
    expect(recordEquality(eq(v("record.ownerId"), v("user.id")), typeOf, everyUser)).toEqual({
      variable: "record.ownerId",
      value: { kind: "user", variable: "user.id" },
    });
  });
  it("takes a null literal against any field", () => {
    expect(recordEquality(eq(v("record.rank"), lit(null)), typeOf, everyUser)).not.toBeNull();
  });
  it("refuses an equality Ring 1 would answer with a type mismatch", () => {
    expect(recordEquality(eq(v("record.title"), lit(5)), typeOf, everyUser)).toBeNull();
    expect(recordEquality(eq(v("record.pinned"), lit("yes")), typeOf, everyUser)).toBeNull();
    expect(recordEquality(eq(v("record.title"), v("user.id")), typeOf, everyUser)).toBeNull();
    expect(recordEquality(eq(v("record.rank"), v("user.email")), typeOf, everyUser)).toBeNull();
  });
  it("takes only the user variables the caller names", () => {
    expect(
      recordEquality(eq(v("record.title"), v("user.email")), typeOf, everyUser),
    ).not.toBeNull();
    expect(recordEquality(eq(v("record.title"), v("user.email")), typeOf, ["user.id"])).toBeNull();
  });
  it("refuses record against record, literal against literal, and unknown variables", () => {
    expect(recordEquality(eq(v("record.rank"), v("record.rank")), typeOf, everyUser)).toBeNull();
    expect(recordEquality(eq(lit(1), lit(1)), typeOf, everyUser)).toBeNull();
    expect(recordEquality(eq(v("record.nope"), lit(1)), typeOf, everyUser)).toBeNull();
    expect(recordEquality(eq(v("record.editorsId"), v("user.id")), typeOf, everyUser)).toBeNull();
  });
  it("refuses anything but an equality", () => {
    const ne: Expression = { kind: "ne", left: v("record.rank"), right: lit(1) };
    expect(recordEquality(ne, typeOf, everyUser)).toBeNull();
  });
});

describe("toRecordFilter", () => {
  it("compiles and/or of equalities", () => {
    const e: Expression = {
      kind: "or",
      args: [
        eq(v("record.pinned"), lit(true)),
        {
          kind: "and",
          args: [eq(v("record.ownerId"), v("user.id")), eq(v("record.rank"), lit(1))],
        },
      ],
    };
    expect(toRecordFilter(e, typeOf, everyUser)).toEqual({
      kind: "or",
      args: [
        { kind: "eq", variable: "record.pinned", value: { kind: "literal", value: true } },
        {
          kind: "and",
          args: [
            {
              kind: "eq",
              variable: "record.ownerId",
              value: { kind: "user", variable: "user.id" },
            },
            { kind: "eq", variable: "record.rank", value: { kind: "literal", value: 1 } },
          ],
        },
      ],
    });
  });
  it("is null when any part is outside the subset", () => {
    const e: Expression = {
      kind: "and",
      args: [eq(v("record.pinned"), lit(true)), { kind: "not", arg: v("record.pinned") }],
    };
    expect(toRecordFilter(e, typeOf, everyUser)).toBeNull();
  });
});
