import { describe, expect, it } from "vitest";
import { emitRing1File } from "./ring1";

describe("emitRing1File", () => {
  const php = emitRing1File();
  it("namespaces the conformance-tested Ring1 runtime for PSR-4", () => {
    expect(php.startsWith("<?php\n\ndeclare(strict_types=1);\n\nnamespace App\\Support;\n")).toBe(
      true,
    );
    expect(php).toContain("class Ring1");
    expect(php).toContain("public static function eq(");
  });
  it("does not duplicate the declare statement", () => {
    expect(php.split("declare(strict_types=1);").length).toBe(2); // exactly one occurrence
  });
});
