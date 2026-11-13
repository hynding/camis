import type { GeneratedFile } from "@camis/adapter-kernel";
import type { ContentType, IrDocument, RouteAction, RouteHook } from "@camis/ir-schema";
import { ROUTE_ACTIONS } from "@camis/ir-schema";
import { hookSlug } from "./names";

// Strapi's core router action for each content API action a type of each kind has.
const CORE_ACTIONS: Record<ContentType["kind"], Partial<Record<RouteAction, string>>> = {
  collection: {
    list: "find",
    read: "findOne",
    create: "create",
    update: "update",
    delete: "delete",
  },
  single: { read: "find", update: "update", delete: "delete" },
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
 * The core router's options for a content type: `only` the actions it serves, when not every one,
 * and each served action's `auth: false` when the type opens it to anyone, its policies and middlewares, as Strapi's global ones. Undefined when the
 * IR puts nothing on it.
 */
export const routerConfig = (doc: IrDocument, contentType: string): string | undefined => {
  const ct = doc.contentTypes.find((c) => c.name === contentType);
  if (ct === undefined) return undefined;
  const core = CORE_ACTIONS[ct.kind];
  const served = ROUTE_ACTIONS.filter(
    (a) => core[a] !== undefined && (ct.options?.apiActions ?? ROUTE_ACTIONS).includes(a),
  );
  const refs = (list: RouteHook[] | undefined, action: RouteAction): string[] =>
    (list ?? [])
      .filter((r) => r.contentType === contentType && actionsOf(r).includes(action))
      .map((r) => `"global::${hookSlug(r.name)}"`);
  const rows = served
    .map((action) => {
      const policies = refs(doc.policies, action);
      const middlewares = refs(doc.middlewares, action);
      const parts = [
        ...((ct.options?.publicApiActions ?? []).includes(action) ? ["auth: false"] : []),
        ...(policies.length > 0 ? [`policies: [${policies.join(", ")}]`] : []),
        ...(middlewares.length > 0 ? [`middlewares: [${middlewares.join(", ")}]`] : []),
      ];
      return parts.length === 0 ? undefined : `    ${core[action]}: { ${parts.join(", ")} },`;
    })
    .filter((row): row is string => row !== undefined);
  const only =
    ct.options?.apiActions === undefined
      ? undefined
      : `  only: [${served.map((a) => `"${core[a]}"`).join(", ")}],`;
  const options = [
    ...(only === undefined ? [] : [only]),
    ...(rows.length === 0 ? [] : [`  config: {\n${rows.join("\n")}\n  },`]),
  ];
  return options.length === 0 ? undefined : `{\n${options.join("\n")}\n}`;
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
