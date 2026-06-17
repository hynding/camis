import { describe, expect, it } from "vitest";
import { PHP_RUNTIME } from "./runtime.php";

describe("PHP_RUNTIME", () => {
  it("opens with <?php and defines the Ring1 class with the catalog methods", () => {
    expect(PHP_RUNTIME.startsWith("<?php")).toBe(true);
    for (const m of [
      "lit",
      "var",
      "eq",
      "ne",
      "lt",
      "lte",
      "gt",
      "gte",
      "add",
      "sub",
      "mul",
      "div",
      "and",
      "or",
      "not",
      "isNull",
      "coalesce",
    ]) {
      expect(PHP_RUNTIME).toContain(`function ${m}(`);
    }
  });
  it("uses strcmp and array_key_exists, and no loose == anywhere", () => {
    expect(PHP_RUNTIME).toContain("strcmp");
    expect(PHP_RUNTIME).toContain("array_key_exists");
    // forbid a loose == (a == not part of === / !== / <= / >= / =>)
    expect(/(?<![=!<>])==(?!=)/.test(PHP_RUNTIME)).toBe(false);
  });
});
