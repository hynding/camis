import type { HookScalar } from "@camis/ir-schema";

// kebab file slug from a PascalCase hook name (TransformTitle -> transform-title).
export const hookSlug = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

export const TS_TYPE: Record<HookScalar, string> = {
  string: "string",
  text: "string",
  integer: "number",
  float: "number",
  boolean: "boolean",
  dateTime: "string",
};
