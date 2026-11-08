import type { GeneratedFile } from "@camis/adapter-kernel";
import type { IrDocument, RouteAction, RouteHook } from "@camis/ir-schema";
import { ROUTE_ACTIONS } from "@camis/ir-schema";
import { hookSlug } from "./names";

// Strapi's core router action for each content API action.
const CORE_ACTION: Record<RouteAction, string> = {
  list: "find",
  read: "findOne",
  create: "create",
  update: "update",
  delete: "delete",
};

const actionsOf = (r: RouteHook): readonly RouteAction[] => r.actions ?? ROUTE_ACTIONS;

const describe = (r: RouteHook): string =>
  `${r.contentType}: ${r.actions === undefined ? "every action" : r.actions.join(", ")}`;

const policyStub = (r: RouteHook): string => `import type { Core } from "@strapi/strapi";

// Ring 2 policy — hand-written. camis seeds this once and never overwrites it.
// Strapi runs it before the route's action (${describe(r)}); false answers 403 "Policy Failed".
export default (policyContext, config, { strapi }: { strapi: Core.Strapi }): boolean => {
  // TODO: decide whether the request may go on.
  return true;
};
`;

const middlewareStub = (r: RouteHook): string => `import type { Core } from "@strapi/strapi";

// Ring 2 middleware — hand-written. camis seeds this once and never overwrites it.
// Strapi runs it around the route's action (${describe(r)}), after its policies.
export default (config, { strapi }: { strapi: Core.Strapi }) =>
  async (ctx, next) => {
    // TODO: wrap the request.
    await next();
  };
`;

/**
 * The core router's `config` for a content type: each action's policies and middlewares, as
 * Strapi's global ones. Undefined when the IR puts none on it.
 */
export const routerConfig = (doc: IrDocument, contentType: string): string | undefined => {
  const refs = (list: RouteHook[] | undefined, action: RouteAction): string[] =>
    (list ?? [])
      .filter((r) => r.contentType === contentType && actionsOf(r).includes(action))
      .map((r) => `"global::${hookSlug(r.name)}"`);
  const rows = ROUTE_ACTIONS.map((action) => {
    const policies = refs(doc.policies, action);
    const middlewares = refs(doc.middlewares, action);
    const parts = [
      ...(policies.length > 0 ? [`policies: [${policies.join(", ")}]`] : []),
      ...(middlewares.length > 0 ? [`middlewares: [${middlewares.join(", ")}]`] : []),
    ];
    return parts.length === 0 ? undefined : `    ${CORE_ACTION[action]}: { ${parts.join(", ")} },`;
  }).filter((row): row is string => row !== undefined);
  return rows.length === 0 ? undefined : `{\n  config: {\n${rows.join("\n")}\n  },\n}`;
};

/** A seeded file for each of the IR's route policies and middlewares, where Strapi looks for them. */
export const emitRouteHookFiles = (doc: IrDocument): GeneratedFile[] => [
  ...(doc.policies ?? []).map(
    (r): GeneratedFile => ({
      path: `src/policies/${hookSlug(r.name)}.ts`,
      content: policyStub(r),
      mode: "seed",
    }),
  ),
  ...(doc.middlewares ?? []).map(
    (r): GeneratedFile => ({
      path: `src/middlewares/${hookSlug(r.name)}.ts`,
      content: middlewareStub(r),
      mode: "seed",
    }),
  ),
];
