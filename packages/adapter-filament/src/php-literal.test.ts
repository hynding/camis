import { describe, expect, it } from "vitest";
import { phpSingleQuoted, sqlSingleQuoted } from "./php-literal";

describe("phpSingleQuoted", () => {
  it("wraps a plain string in single quotes and changes nothing else", () => {
    expect(phpSingleQuoted("notes_owner_lnk")).toBe("'notes_owner_lnk'");
  });

  it("escapes a single quote so the literal cannot be closed early", () => {
    expect(phpSingleQuoted("o'brien")).toBe("'o\\'brien'");
  });

  it("escapes a backslash before escaping quotes, so \\' cannot be reconstructed", () => {
    expect(phpSingleQuoted("a\\'b")).toBe("'a\\\\\\'b'");
  });

  it("leaves a PHP variable sigil inert — a single-quoted literal never interpolates", () => {
    expect(phpSingleQuoted("$user->id")).toBe("'$user->id'");
  });
});

describe("sqlSingleQuoted", () => {
  it("doubles a single quote, the ANSI escape", () => {
    expect(sqlSingleQuoted("o'brien")).toBe("'o''brien'");
  });

  it("leaves a backslash alone — it is not an escape character in standard SQL", () => {
    expect(sqlSingleQuoted("a\\b")).toBe("'a\\b'");
  });
});
