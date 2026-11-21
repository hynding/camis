// The boot job's route guard: which content API routes a role can reach that the allowlist does
// not name. users-permissions decides a route by its `config.auth.scope` (Strapi fills it from a
// string handler), lets any authenticated caller through a route with no scope, and anyone
// through one with `auth: false`.

export interface ListedRoute {
  method: string;
  path: string;
  /** `api::<name>` or `plugin::<name>`, which a relative handler or scope action is under. */
  namespace: string;
  /** The handler's action, or null for a function handler. */
  handler: string | null;
  /** `false` for `auth: false`; the explicit scope, if any; null for neither. */
  auth: false | { scope?: readonly string[] } | null;
}

export interface Granted {
  role: string | null;
  action: string;
}

const qualified = (namespace: string, action: string): string =>
  action.includes("::") ? action : `${namespace}.${action}`;

/** Each reachable route's unallowlisted action, as a line naming the route and who reaches it. */
export const routeProblems = (
  routes: readonly ListedRoute[],
  granted: readonly Granted[],
  allowlist: Readonly<Record<string, unknown>>,
): string[] => {
  const holders = new Map<string, string[]>();
  for (const g of granted) holders.set(g.action, [...(holders.get(g.action) ?? []), g.role ?? "?"]);
  const named = (key: string): boolean =>
    Object.prototype.hasOwnProperty.call(allowlist, key) && typeof allowlist[key] === "string";
  const problems: string[] = [];
  for (const route of routes) {
    const where = `${route.method} ${route.path}`;
    const handler = route.handler === null ? null : qualified(route.namespace, route.handler);
    if (route.auth === false) {
      const key = handler ?? where;
      if (!named(key))
        problems.push(`${where}: ${key} (auth: false, open to anyone) is not allowlisted`);
      continue;
    }
    const scope = (route.auth?.scope ?? (handler === null ? [] : [handler])).map((a) =>
      qualified(route.namespace, a),
    );
    if (scope.length === 0) {
      if (!named(where))
        problems.push(
          `${where}: no scope, so open to any authenticated caller; allowlist it as ${where}`,
        );
      continue;
    }
    const roles = [...new Set(scope.flatMap((a) => holders.get(a) ?? []))];
    if (roles.length === 0) continue;
    for (const action of scope)
      if (!named(action))
        problems.push(`${where}: ${action} (held by ${roles.join(", ")}) is not allowlisted`);
    if (handler !== null && !scope.includes(handler) && !named(handler))
      problems.push(
        `${where}: ${handler} (handler, held through its scope by ${roles.join(", ")}) is not allowlisted`,
      );
  }
  return problems;
};
