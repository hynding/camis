import { readFileSync } from "node:fs";
import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import { tsRuntimeSource } from "@camis/expr-ts";
import type { Expression } from "@camis/expr";
import type { RecordFilter } from "@camis/permissions";
import type { ApiEnforcement, ApiHolding, ApiTypeRules } from "./api-enforcement";
import { handlerBody } from "./conditions";

export const API_CONDITIONS_PATH = "src/permissions/api-conditions.ts";
export const API_CONTROLLER_PATH = "src/permissions/api-controller.ts";

const runtime = (name: string): string =>
  readFileSync(new URL(`./runtime/${name}`, import.meta.url), "utf8");

/** The decisions' module body: its Value type comes from the Ring 1 runtime above it. */
const decisionsSource = (): string =>
  runtime("api-conditions.ts").replace(/^import type \{[^}]+\} from "@camis\/expr";\n\n?/m, "");

const key = (name: string): string => JSON.stringify(name);

const holding = (h: ApiHolding): string =>
  h === true ? "true" : `[${h.map((name) => `CONDITIONS[${key(name)}]`).join(", ")}]`;

const list = (items: readonly string[]): string => `[${items.map(key).join(", ")}]`;

const typeRules = (t: ApiTypeRules): string => {
  const variables = Object.entries(t.variables)
    .map(
      ([name, v]) =>
        `      ${key(name)}: { field: ${key(v.field)}, relation: ${String(v.relation)} },`,
    )
    .join("\n");
  const roles = Object.keys(t.roles)
    .sort()
    .map((role) => {
      const rules = t.roles[role]!;
      const actions = (["read", "create", "update", "delete"] as const)
        .filter((a) => rules[a] !== undefined)
        .map((a) => `${a}: ${holding(rules[a]!)}`);
      const lines = [...actions, `assign: ${list(rules.assign)}`].map((l) => `        ${l},`);
      return `      ${key(role)}: {\n${lines.join("\n")}\n      },`;
    })
    .join("\n");
  return `  ${key(t.uid)}: {
    variables: {${variables === "" ? "" : `\n${variables}\n    `}},
    open: ${list(t.open)},
    assign: ${list(t.assign)},
    admins: ADMIN_ROLES,
    roles: {
${roles}
    },
  },`;
};

/** A Ring 1 predicate as a test: true only when it evaluates to true, so an error denies. */
const test = (predicate: Expression, indent: string): string => `(data) => {
${indent}  const result = ${handlerBody(predicate)};
${indent}  return result.ok === true && result.value === true;
${indent}}`;

/** A row filter as code: its caller parts become Ring 1 tests. */
const filterSource = (filter: RecordFilter): string => {
  if (filter.kind === "caller")
    return `{ kind: "caller", test: ${test(filter.expression, "    ")} }`;
  if (filter.kind === "eq") return JSON.stringify(filter);
  return `{ kind: ${JSON.stringify(filter.kind)}, args: [${filter.args.map(filterSource).join(", ")}] }`;
};

const rulesSource = (enforcement: ApiEnforcement): string => {
  const conditions = enforcement.conditions
    .map(
      (c) => `  ${key(c.name)}: {
    test: ${test(c.predicate, "    ")},
    filter: ${c.filter === null ? "null" : filterSource(c.filter)},
  },`,
    )
    .join("\n");
  const admins = enforcement.types[0]?.admins ?? [];
  return `// The project's rules: generated from the IR's roles.

const CONDITIONS: Record<string, Condition> = {
${conditions}
};

const ADMIN_ROLES: readonly string[] = ${list(admins)};

export const RULES: Record<string, TypeRules> = {
${enforcement.types.map(typeRules).join("\n")}
};
`;
};

/** A type's controller: Strapi's core controller, with the enforced actions over it. */
export const enforcedControllerSource = (uid: string): string =>
  withMarker(`import { factories } from "@strapi/strapi";
import { RULES } from "../../../permissions/api-conditions";
import { enforcedController } from "../../../permissions/api-controller";

// The IR's row conditions and assigned fields, decided before Strapi's core actions run. The
// methods are type-checked by camis against the parts of Strapi they use; the cast keeps
// Strapi's own controller typings, which camis does not check them against, out of the build.
export default factories.createCoreController(${key(uid)}, ({ strapi }) =>
  enforcedController(strapi, ${key(uid)}, RULES[${key(uid)}]) as any,
);
`);

/** The decisions module (Ring 1 runtime, decisions, the project's rules) and the controller methods. */
export const emitApiEnforcementFiles = (enforcement: ApiEnforcement): GeneratedFile[] =>
  enforcement.types.length === 0
    ? []
    : [
        {
          path: API_CONDITIONS_PATH,
          content: withMarker(
            `${tsRuntimeSource()}\n${decisionsSource()}\n${rulesSource(enforcement)}`,
          ),
        },
        { path: API_CONTROLLER_PATH, content: withMarker(runtime("api-controller.ts")) },
      ];
