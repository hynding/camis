import type { Expression } from "@camis/expr";
import { emitTs, tsRuntimeSource } from "@camis/expr-ts";
import type { NamedCondition } from "./project";

/** The emitted Ring-1 expression for a predicate (references `r` and `data`). */
export const handlerBody = (predicate: Expression): string => emitTs(predicate);

const handler = (predicate: Expression): string =>
  `(user: { id?: unknown; email?: unknown; role?: { name?: unknown } }) => {
    const data: Record<string, Value> = {
      "user.id": (user?.id ?? null) as Value,
      "user.email": (user?.email ?? null) as Value,
      "user.role": (user?.role?.name ?? null) as Value,
    };
    const result = ${handlerBody(predicate)};
    return result.ok === true && result.value === true;
  }`;

/** A self-contained Strapi conditions module embedding the Ring-1 runtime. */
export const emitConditionsModule = (conditions: NamedCondition[]): string => {
  const entries = conditions
    .map(
      (c) =>
        `  {\n    displayName: ${JSON.stringify(c.name)},\n    name: ${JSON.stringify(c.name)},\n    plugin: "admin",\n    handler: ${handler(c.predicate)},\n  },`,
    )
    .join("\n");
  return `${tsRuntimeSource()}\nexport const conditions = [\n${entries}\n];\n`;
};
