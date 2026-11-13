import { TS_MARKER } from "@camis/adapter-kernel";
import {
  endpoint as endpointSchema,
  ENDPOINT_METHODS,
  type CapabilityGap,
  type Endpoint,
  type IrDocument,
} from "@camis/ir-schema";
import type { ProjectFile } from "./custom-code";
import { readExportedValue, type Literal } from "./literal";
import { irName } from "./names";

/** What a project's custom routes files declare. */
export interface EndpointImport {
  endpoints: Endpoint[];
  gaps: CapabilityGap[];
  /** The routes files read whole; the rest stay `customRoutes` gaps of the custom code report. */
  read: Set<string>;
}

const ROUTES = /^src\/api\/([^/]+)\/routes\/[^/]+\.(?:[cm]?js|ts|php)$/;

const isRecord = (v: Literal | undefined): v is { [key: string]: Literal } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const pascal = (name: string): string =>
  name
    .split(/[-_.]/)
    .filter((w) => w !== "")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

/**
 * The endpoint's name from its handler: the controller's, with the action's unless it is
 * `handle` (the one action of a controller camis wrote), as `article.like` names ArticleLike.
 */
const nameOf = (handler: string): string | undefined => {
  const parts = handler.replace(/^api::[^.]+\./, "").split(".");
  if (parts.length !== 2 || parts.some((p) => !/^[\w-]+$/.test(p))) return undefined;
  const [controller, action] = parts as [string, string];
  return action === "handle" ? pascal(controller) : `${pascal(controller)}${pascal(action)}`;
};

class EndpointReader {
  readonly endpoints: Endpoint[] = [];
  readonly gaps: CapabilityGap[] = [];
  readonly read = new Set<string>();

  constructor(private readonly doc: IrDocument) {}

  private gap(feature: string, file: string, message: string, contentType?: string): void {
    this.gaps.push({
      feature,
      location: contentType === undefined ? { file } : { contentType, file },
      severity: "downgrade",
      message,
    });
  }

  file(file: ProjectFile, api: string): void {
    const exported = readExportedValue(file.content);
    const routes = isRecord(exported) ? exported.routes : undefined;
    if (!Array.isArray(routes) || !routes.every(isRecord)) return;
    this.read.add(file.path);
    const ct = this.doc.contentTypes.find((c) => c.name === irName(api));
    for (const route of routes) this.route(file.path, api, ct?.name, route);
  }

  private route(
    file: string,
    api: string,
    contentType: string | undefined,
    route: { [key: string]: Literal },
  ): void {
    const { method, path, handler } = route;
    const config = isRecord(route.config) ? route.config : {};
    const said = `${String(method)} ${String(path)}`;
    if (contentType === undefined) {
      this.gap(
        "endpointContentType",
        file,
        `the custom route ${said} belongs to the API "${api}", which has no content type; declare it as an IR endpoint beside one by hand`,
      );
      return;
    }
    const name = typeof handler === "string" ? nameOf(handler) : undefined;
    const parsed = endpointSchema.safeParse({
      name,
      contentType,
      method: typeof method === "string" ? method.toUpperCase() : method,
      path,
      ...(config.auth === false ? { public: true } : {}),
    });
    if (!parsed.success || this.endpoints.some((e) => e.name === name)) {
      this.gap(
        "endpointPath",
        file,
        `the custom route ${said} is not imported: an endpoint is one of ${ENDPOINT_METHODS.join(", ")} on a path of /segments and :params, with a "<controller>.<action>" handler of its own`,
        contentType,
      );
      return;
    }
    const endpoint = parsed.data;
    if (config.policies !== undefined || config.middlewares !== undefined)
      this.gap(
        "endpointHook",
        file,
        `the policies and middlewares on ${said} are not imported; check them in ${endpoint.name}'s handler`,
        contentType,
      );
    if (config.auth !== undefined && config.auth !== true && config.auth !== false)
      this.gap(
        "routeAuth",
        file,
        `${said} sets an auth scope or strategy, which camis does not import: the roles that list ${endpoint.name} may call it`,
        contentType,
      );
    this.endpoints.push(endpoint);
    if (endpoint.public !== true)
      this.gap(
        "endpointRoles",
        file,
        `Strapi keeps who may call ${said} in its database: list ${endpoint.name} in the endpoints of each IR role that may`,
        contentType,
      );
  }
}

/**
 * The endpoints each hand-written custom routes file declares (`{ routes: [...] }`), read from its
 * literal routes: each route's method, path, handler (which names the endpoint) and `auth: false`.
 * Core routers and the routes files camis generated are passed over; a file whose routes are not
 * literals is left out of `read`, for the custom code report to name.
 */
export const importEndpoints = (files: ProjectFile[], doc: IrDocument): EndpointImport => {
  const reader = new EndpointReader(doc);
  const routeFiles = files
    .filter(
      (f) =>
        ROUTES.test(f.path) &&
        !f.content.startsWith(TS_MARKER) &&
        !/createCoreRouter\s*\(/.test(f.content),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const file of routeFiles) reader.file(file, ROUTES.exec(file.path)![1]!);
  return { endpoints: reader.endpoints, gaps: reader.gaps, read: reader.read };
};
