import type { ContentType } from "@camis/ir-schema";

/**
 * Indent levels and the authorize-line helper shared by the two controller layouts. They live
 * apart from `controller.ts` so the Strapi-storage half can use them without importing back into
 * the module that imports it — a runtime import cycle rather than a type-only one.
 */

// PSR-12 indent levels inside a method body.
export const STMT = "        "; // 8 spaces: a top-level statement in a method body
export const NESTED_STMT = "            "; // 12 spaces: a statement inside a method-body if-block

/**
 * `indent` lets a single call site emit at whatever nesting depth it sits in (the update()
 * create branch and the update() if-block sit one level apart).
 */
export const authLine =
  (secured: boolean) =>
  (line: string, indent: string = STMT): string =>
    secured ? `${indent}${line}\n` : "";

/** What the create checks read of a controller's spec. */
interface CheckedSpec {
  ct: ContentType;
  secured: boolean;
  shape: { model: string };
}

// Strapi's single type has no create action: its update grant makes the one entry, so the check
// waits for the new row, which a grant's condition reads.
export const createCheck = (spec: CheckedSpec): string =>
  spec.ct.kind === "single"
    ? ""
    : authLine(spec.secured)(`$this->authorize('create', ${spec.shape.model}::class);`);
export const madeCheck = (spec: CheckedSpec): string =>
  spec.ct.kind === "single" ? authLine(spec.secured)(`$this->authorize('update', $m);`) : "";
