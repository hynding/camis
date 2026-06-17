import { z } from "zod";
import type { Value } from "./value";

export type Expression =
  | { kind: "lit"; value: Value }
  | { kind: "var"; name: string }
  | { kind: "eq" | "ne" | "lt" | "lte" | "gt" | "gte"; left: Expression; right: Expression }
  | { kind: "add" | "sub" | "mul" | "div"; left: Expression; right: Expression }
  | { kind: "and" | "or"; args: Expression[] }
  | { kind: "not"; arg: Expression }
  | { kind: "call"; fn: "isNull" | "coalesce"; args: Expression[] };

const litValue = z.union([z.null(), z.boolean(), z.number().finite(), z.string()]);

export const expression: z.ZodType<Expression> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("lit"), value: litValue }),
    z.object({ kind: z.literal("var"), name: z.string() }),
    z.object({
      kind: z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]),
      left: expression,
      right: expression,
    }),
    z.object({ kind: z.enum(["add", "sub", "mul", "div"]), left: expression, right: expression }),
    z.object({ kind: z.enum(["and", "or"]), args: z.array(expression).min(1) }),
    z.object({ kind: z.literal("not"), arg: expression }),
    z
      .object({
        kind: z.literal("call"),
        fn: z.enum(["isNull", "coalesce"]),
        args: z.array(expression),
      })
      .superRefine((val, ctx) => {
        if (val.fn === "isNull" && val.args.length !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "isNull takes exactly one argument",
            path: ["args"],
          });
        }
        if (val.fn === "coalesce" && val.args.length < 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "coalesce takes at least one argument",
            path: ["args"],
          });
        }
      }),
  ]),
);
