import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { evaluate } from "@camis/expr-ts";
import { emitPhp, PHP_RUNTIME } from "@camis/expr-php-emit";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const condition: Expression = {
  kind: "eq",
  left: { kind: "var", name: "record.status" },
  right: { kind: "lit", value: "published" },
};

const cases: Record<string, string | null>[] = [
  { "record.status": "published" },
  { "record.status": "draft" },
  {},
];

describe("policy PHP conformance tie-in", () => {
  let dir = "";
  let runtimePath = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "policy-conf-"));
    runtimePath = join(dir, "Ring1.php");
    writeFileSync(runtimePath, PHP_RUNTIME);
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasPhp())("emitted Policy condition in PHP matches the Ring-1 TS interpreter", () => {
    for (const data of cases) {
      const php = `<?php require '${runtimePath}'; $data = json_decode('${JSON.stringify(data)}', true) ?? []; echo json_encode(${emitPhp(condition)});`;
      const file = join(dir, "c.php");
      writeFileSync(file, php);
      const got = JSON.parse(execFileSync("php", [file], { encoding: "utf8" })) as unknown;
      const want = evaluate(condition, data as Record<string, string | null>);
      expect(got).toEqual(want);
    }
  });
});
