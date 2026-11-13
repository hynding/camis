import { TS_MARKER } from "@camis/adapter-kernel";
import {
  ROUTE_ACTIONS,
  type CapabilityGap,
  type ContentType,
  type IrDocument,
  type RouteAction,
  type RouteHook,
} from "@camis/ir-schema";
import type { ProjectFile } from "./custom-code";
import { OPAQUE, readCallArguments, type Literal } from "./literal";
import { irName } from "./names";

/** What a project's core routers say about its content types' API routes. */
export interface RouterImport {
  /** Per type serving only some of its actions, those it serves (in ROUTE_ACTIONS order). */
  apiActions: Map<string, RouteAction[]>;
  /** Per type, the served actions whose route sets `auth: false` (in ROUTE_ACTIONS order). */
  publicApiActions: Map<string, RouteAction[]>;
  policies: RouteHook[];
  middlewares: RouteHook[];
  gaps: CapabilityGap[];
}

const ROUTER = /^src\/api\/[^/]+\/routes\/[^/]+\.(?:[cm]?js|ts|php)$/;

// Each core router action, and the content API action camis calls it.
const CORE_ACTIONS: Record<ContentType["kind"], Record<string, RouteAction>> = {
  collection: {
    find: "list",
    findOne: "read",
    create: "create",
    update: "update",
    delete: "delete",
  },
  single: { find: "read", update: "update", delete: "delete" },
};

type Hooks = "policies" | "middlewares";
const SINGULAR: Record<Hooks, string> = { policies: "policy", middlewares: "middleware" };

const isRecord = (v: Literal | undefined): v is { [key: string]: Literal } =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: Literal | undefined): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

const pascal = (name: string): string =>
  name
    .split(/[-_]/)
    .filter((w) => w !== "")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

/** One policy or middleware an action names, before it gets its IR name. */
interface Use {
  list: Hooks;
  contentType: string;
  base: string;
  actions: RouteAction[];
}

class RouterReader {
  readonly apiActions = new Map<string, RouteAction[]>();
  readonly publicApiActions = new Map<string, RouteAction[]>();
  readonly uses: Use[] = [];
  readonly gaps: CapabilityGap[] = [];

  constructor(private readonly doc: IrDocument) {}

  private gap(feature: string, file: string, message: string, contentType?: string): void {
    this.gaps.push({
      feature,
      location: contentType === undefined ? { file } : { contentType, file },
      severity: "downgrade",
      message,
    });
  }

  read(file: ProjectFile): void {
    const args = readCallArguments(file.content, "createCoreRouter");
    if (args === undefined) return;
    const [uid, options = {}] = args;
    const ct =
      typeof uid === "string" && uid.startsWith("api::")
        ? this.doc.contentTypes.find((c) => c.name === irName(uid.split(".").pop() ?? ""))
        : undefined;
    const served = ct === undefined || !isRecord(options) ? undefined : this.served(ct, options);
    if (ct === undefined || !isRecord(options) || served === undefined) {
      this.gap(
        "routeConfig",
        file.path,
        "the core router's options could not be read as literals; declare its routes, policies and middlewares in the IR by hand",
      );
      return;
    }
    if (served.length < Object.keys(CORE_ACTIONS[ct.kind]).length)
      this.apiActions.set(ct.name, served);
    const prefix = options.prefix;
    if (prefix !== undefined && prefix !== "")
      this.gap(
        "routePrefix",
        file.path,
        `the routes' prefix ${prefix === OPAQUE ? "" : `${JSON.stringify(prefix)} `}is not imported; camis serves ${ct.name} at Strapi's default path`,
        ct.name,
      );
    const config = isRecord(options.config) ? options.config : {};
    for (const [coreAction, action] of Object.entries(CORE_ACTIONS[ct.kind])) {
      if (!served.includes(action)) continue;
      const route = config[coreAction];
      if (isRecord(route)) this.route(file.path, ct, coreAction, action, route);
    }
  }

  /** The actions `only` and `except` leave the type, or undefined when either is unreadable. */
  private served(ct: ContentType, options: { [key: string]: Literal }): RouteAction[] | undefined {
    const { only, except = [] } = options;
    if ((only !== undefined && !isStrings(only)) || !isStrings(except)) return undefined;
    const core = CORE_ACTIONS[ct.kind];
    const kept = Object.keys(core).filter(
      (a) => (only === undefined || only.includes(a)) && !except.includes(a),
    );
    return ROUTE_ACTIONS.filter((a) => kept.some((k) => core[k] === a));
  }

  private route(
    file: string,
    ct: ContentType,
    coreAction: string,
    action: RouteAction,
    route: { [key: string]: Literal },
  ): void {
    if (route.auth === false) this.open(ct.name, action);
    else if (route.auth !== undefined && route.auth !== true)
      this.gap(
        "routeAuth",
        file,
        `${ct.name}'s ${coreAction} route sets an auth scope or strategy, which camis does not import: it checks the caller's role's grant`,
        ct.name,
      );
    for (const list of ["policies", "middlewares"] as const) {
      const named = route[list];
      if (named === undefined) continue;
      const entries: Literal[] = Array.isArray(named) ? named : [named];
      for (const entry of entries) this.use(file, ct, coreAction, action, list, entry);
    }
  }

  private open(contentType: string, action: RouteAction): void {
    const open = [...(this.publicApiActions.get(contentType) ?? []), action];
    this.publicApiActions.set(
      contentType,
      ROUTE_ACTIONS.filter((a) => open.includes(a)),
    );
  }

  private use(
    file: string,
    ct: ContentType,
    coreAction: string,
    action: RouteAction,
    list: Hooks,
    entry: Literal,
  ): void {
    const kind = SINGULAR[list];
    const name = typeof entry === "string" ? entry : isRecord(entry) ? entry.name : undefined;
    if (typeof name !== "string") {
      this.gap(
        list === "policies" ? "inlinePolicy" : "inlineMiddleware",
        file,
        `an inline ${kind} on ${ct.name}'s ${coreAction} route is not imported; declare it in the IR's ${list} and port its code into the seeded class`,
        ct.name,
      );
      return;
    }
    const own = /^(?:global::|api::[^.]+\.)?([\w-]+)$/.exec(name);
    if (own === null) {
      this.gap(
        list === "policies" ? "pluginPolicy" : "pluginMiddleware",
        file,
        `the ${kind} "${name}" on ${ct.name}'s ${coreAction} route belongs to a plugin and is not imported; port what it checks into an IR ${kind}`,
        ct.name,
      );
      return;
    }
    if (isRecord(entry) && entry.config !== undefined)
      this.gap(
        "routeHookConfig",
        file,
        `the config given to the ${kind} "${name}" on ${ct.name}'s ${coreAction} route is not imported; an IR ${kind} takes none, so carry it in the seeded class`,
        ct.name,
      );
    const base = pascal(own[1]!);
    const found = this.uses.find(
      (u) => u.list === list && u.contentType === ct.name && u.base === base,
    );
    if (found === undefined)
      this.uses.push({ list, contentType: ct.name, base, actions: [action] });
    else if (!found.actions.includes(action)) found.actions.push(action);
  }
}

/**
 * Each use gets its policy or middleware's name, prefixed with its type's where the name is used
 * on another type too, and suffixed with its kind where a policy and a middleware share both:
 * every IR hook becomes a class of its own name.
 */
const routeHooks = (uses: Use[], doc: IrDocument, list: Hooks): RouteHook[] => {
  const count = (pick: (u: Use) => string, value: string): number =>
    uses.filter((u) => pick(u) === value).length;
  return uses
    .filter((u) => u.list === list)
    .map((u): RouteHook => {
      let name = count((x) => x.base, u.base) > 1 ? `${u.contentType}${u.base}` : u.base;
      if (count((x) => `${x.contentType}${x.base}`, `${u.contentType}${u.base}`) > 1)
        name += list === "policies" ? "Policy" : "Middleware";
      const ct = doc.contentTypes.find((c) => c.name === u.contentType)!;
      const all = Object.values(CORE_ACTIONS[ct.kind]);
      const actions = ROUTE_ACTIONS.filter((a) => u.actions.includes(a));
      return {
        name,
        contentType: u.contentType,
        ...(all.every((a) => actions.includes(a)) ? {} : { actions }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * The routes each hand-written core router (`createCoreRouter`) leaves its content type, and the
 * project's own policies and middlewares its actions name, read from the router's literal options:
 * its `only`/`except` and each action's `config` (`auth: false` opens the action to anyone). What the IR cannot hold is a gap located by the
 * router's file; a router whose options are not literals is one `routeConfig` gap. Routers camis
 * generated are passed over (the IR they came from already holds them), as are custom route files.
 */
export const importRouters = (files: ProjectFile[], doc: IrDocument): RouterImport => {
  const reader = new RouterReader(doc);
  const routers = files
    .filter((f) => ROUTER.test(f.path) && !f.content.startsWith(TS_MARKER))
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const file of routers) reader.read(file);
  return {
    apiActions: reader.apiActions,
    publicApiActions: reader.publicApiActions,
    policies: routeHooks(reader.uses, doc, "policies"),
    middlewares: routeHooks(reader.uses, doc, "middlewares"),
    gaps: reader.gaps,
  };
};
