import { describe, expect, it } from "vitest";
import type { Expression } from "./ast";
import { formatExpression } from "./format";

const v = (name: string): Expression => ({ kind: "var", name });
const lit = (value: string | number | boolean | null): Expression => ({ kind: "lit", value });

// How an admin reads a grant's condition: the expression in a compact infix form.
describe("formatExpression", () => {
  it("writes comparisons infix, strings quoted as JSON", () => {
    expect(formatExpression({ kind: "eq", left: v("record.ownerId"), right: v("user.id") })).toBe(
      "record.ownerId = user.id",
    );
    expect(formatExpression({ kind: "gte", left: v("record.age"), right: lit(18) })).toBe(
      "record.age >= 18",
    );
    expect(formatExpression({ kind: "ne", left: v("a"), right: lit('say "hi"') })).toBe(
      'a != "say \\"hi\\""',
    );
  });

  it("brackets an operand only where its precedence needs it", () => {
    const either: Expression = {
      kind: "or",
      args: [
        { kind: "eq", left: v("record.visibility"), right: lit("public") },
        { kind: "eq", left: v("record.creatorId"), right: v("user.id") },
      ],
    };
    expect(formatExpression(either)).toBe(
      'record.visibility = "public" or record.creatorId = user.id',
    );
    expect(formatExpression({ kind: "and", args: [either, { kind: "not", arg: v("x") }] })).toBe(
      '(record.visibility = "public" or record.creatorId = user.id) and not x',
    );
    expect(
      formatExpression({
        kind: "mul",
        left: { kind: "add", left: v("a"), right: lit(1) },
        right: v("b"),
      }),
    ).toBe("(a + 1) * b");
    expect(
      formatExpression({
        kind: "sub",
        left: v("a"),
        right: { kind: "sub", left: v("b"), right: v("c") },
      }),
    ).toBe("a - (b - c)");
  });

  it("writes calls and literals as written", () => {
    expect(
      formatExpression({ kind: "call", fn: "coalesce", args: [v("a"), lit(null), lit(true)] }),
    ).toBe("coalesce(a, null, true)");
    expect(formatExpression({ kind: "call", fn: "isNull", args: [v("record.deletedAt")] })).toBe(
      "isNull(record.deletedAt)",
    );
  });
});
