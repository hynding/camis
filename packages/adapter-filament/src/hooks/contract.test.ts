import { describe, expect, it } from "vitest";
import type { Hook } from "@camis/ir-schema";
import { emitHookContract } from "./contract";

const h: Hook = {
  name: "TransformTitle",
  trigger: "onPublish",
  contentType: "Article",
  input: [{ name: "title", type: "string" }],
  output: [{ name: "title", type: "string" }],
};

describe("emitHookContract (filament)", () => {
  const php = emitHookContract(h);
  it("emits a marked, namespaced interface with phpdoc array shapes", () => {
    expect(php.startsWith("<?php\n// @camis:generated")).toBe(true);
    expect(php).toContain("namespace App\\Hooks\\Contracts;");
    expect(php).toContain("interface TransformTitleHook");
    expect(php).toContain("@param array{title: string} $input");
    expect(php).toContain("@return array{title: string}");
    expect(php).toContain("public function run(array $input): array;");
  });
});
