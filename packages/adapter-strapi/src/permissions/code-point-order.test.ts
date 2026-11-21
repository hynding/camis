import { describe, expect, it } from "vitest";
import { codePointOrder } from "./code-point-order";

describe("codePointOrder", () => {
  // localeCompare follows the machine's collation (lower case before upper in most); generated
  // files must be the same bytes everywhere.
  it("orders strings by code point, upper case before lower", () => {
    expect(["pina", "pinA", "b", "B", "a"].sort(codePointOrder)).toEqual([
      "B",
      "a",
      "b",
      "pinA",
      "pina",
    ]);
    expect(codePointOrder("x", "x")).toBe(0);
  });
});
