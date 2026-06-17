import { describe, expect, it } from "vitest";
import { vectors } from "@camis/expr";
import { evaluate } from "./evaluate";

describe("conformance — interpreter", () => {
  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    expect(evaluate(v.expr, v.data)).toEqual(v.expect);
  });
});
