import type { Expression } from "@camis/expr";
import { CREATED_BY, CREATOR_SHARES_ROLE } from "@camis/permissions";
import { describe, expect, it } from "vitest";
import { readableCondition } from "./readable-condition";

const v = (name: string): Expression => ({ kind: "var", name });
const lit = (value: string | number | boolean | null): Expression => ({ kind: "lit", value });
const eq = (left: Expression, right: Expression): Expression => ({ kind: "eq", left, right });

describe("readableCondition", () => {
  it("names Strapi's own conditions as its admin does", () => {
    expect(readableCondition(eq(v(CREATED_BY), v("user.id")))).toBe("Is creator");
    expect(readableCondition(eq(v("user.id"), v(CREATED_BY)))).toBe("Is creator");
    expect(
      readableCondition({
        kind: "or",
        args: [eq(v(CREATED_BY), v("user.id")), eq(v(CREATOR_SHARES_ROLE), lit(true))],
      }),
    ).toBe("Is creator or has same role as creator");
  });

  it("says a comparison in words, the record's fields by name and the user's as the user's", () => {
    expect(readableCondition(eq(v("record.ownerId"), v("user.id")))).toBe(
      "Owner id is the user's id",
    );
    expect(readableCondition({ kind: "gt", left: v("record.price"), right: lit(10) })).toBe(
      "Price is more than 10",
    );
    expect(readableCondition({ kind: "ne", left: v("user.role"), right: lit("editor") })).toBe(
      'The user\'s role is not "editor"',
    );
    expect(readableCondition({ kind: "lte", left: v("record.stock"), right: lit(0) })).toBe(
      "Stock is at most 0",
    );
  });

  it("joins alternatives and requirements, bracketing a group inside the other", () => {
    expect(
      readableCondition({
        kind: "or",
        args: [eq(v("record.visibility"), lit("public")), eq(v(CREATED_BY), v("user.id"))],
      }),
    ).toBe('Visibility is "public" or is creator');
    expect(
      readableCondition({
        kind: "and",
        args: [
          eq(v("record.active"), lit(true)),
          { kind: "or", args: [eq(v("record.a"), lit(1)), eq(v("record.b"), lit(2))] },
        ],
      }),
    ).toBe("Active is true and (a is 1 or b is 2)");
  });

  it("says empty for null, and negates", () => {
    expect(
      readableCondition({
        kind: "not",
        arg: { kind: "call", fn: "isNull", args: [v("record.publishedAt")] },
      }),
    ).toBe("Published at is not empty");
    expect(readableCondition(eq(v("record.deletedAt"), lit(null)))).toBe("Deleted at is empty");
    expect(readableCondition({ kind: "not", arg: eq(v("record.a"), lit(1)) })).toBe("Not (a is 1)");
  });

  it("keeps arithmetic's operators, and another call in its compact form", () => {
    expect(
      readableCondition({
        kind: "gt",
        left: { kind: "sub", left: v("record.total"), right: v("record.paid") },
        right: lit(0),
      }),
    ).toBe("Total - paid is more than 0");
    expect(
      readableCondition(
        eq({ kind: "call", fn: "coalesce", args: [v("record.a"), lit(0)] }, lit(1)),
      ),
    ).toBe("Coalesce(record.a, 0) is 1");
  });
});
