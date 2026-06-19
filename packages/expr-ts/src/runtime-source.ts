import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PREAMBLE = `export type Value = null | boolean | number | string;
type EvalError = "TYPE_MISMATCH" | "DIV_BY_ZERO" | "UNKNOWN_VAR";
export type EvalResult = { ok: true; value: Value } | { ok: false; error: EvalError };
const ok = (value: Value): EvalResult => ({ ok: true, value });
const err = (error: EvalError): EvalResult => ({ ok: false, error });
`;

const runtimePath = fileURLToPath(new URL("./runtime.ts", import.meta.url));

/**
 * The Ring-1 TS runtime as a self-contained, embeddable module for generated projects.
 * Strips the `@camis/expr` import (those names are inlined by PREAMBLE); the operator
 * body is copied verbatim from the conformance-tested runtime, so semantics cannot drift.
 */
export const tsRuntimeSource = (): string => {
  const body = readFileSync(runtimePath, "utf8").replace(
    /^import\s+{[^}]+}\s+from\s+"@camis\/expr";\n/m,
    "",
  );
  return PREAMBLE + body;
};
