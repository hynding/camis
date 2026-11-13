import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import type { ContentType, Endpoint, IrDocument } from "@camis/ir-schema";
import { strapiNames } from "@camis/strapi-schema";
import { hookSlug } from "./names";

// Each endpoint's controller has one action, which its route names.
const ACTION = "handle";

/** The handler Strapi's route names for an endpoint: its own controller's one action. */
export const endpointHandler = (endpoint: Endpoint, ct: ContentType): string =>
  `api::${strapiNames(ct).singularName}.${hookSlug(endpoint.name)}.${ACTION}`;

const route = (endpoint: Endpoint, ct: ContentType): string =>
  `    {
      method: "${endpoint.method}",
      path: "${endpoint.path}",
      handler: "${endpointHandler(endpoint, ct)}",${endpoint.public === true ? "\n      config: { auth: false }," : ""}
    },`;

// Strapi loads a routes directory in file name order, so these come before the core router's.
const routesFile = (ct: ContentType, endpoints: Endpoint[]): GeneratedFile => ({
  path: `src/api/${strapiNames(ct).singularName}/routes/01-endpoints.ts`,
  content: withMarker(
    `export default {\n  routes: [\n${endpoints.map((e) => route(e, ct)).join("\n")}\n  ],\n};\n`,
  ),
});

const controllerStub = (
  endpoint: Endpoint,
  ct: ContentType,
): string => `import type { Core } from "@strapi/strapi";

// Ring 2 endpoint — hand-written. camis seeds this once and never overwrites it.
// Strapi answers ${endpoint.method} /api${endpoint.path} with it (${endpointHandler(endpoint, ct)}).
export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async ${ACTION}(ctx) {
    // TODO: answer the request; ctx.params holds the path's :params.
    ctx.body = { data: null };
  },
});
`;

/** Per content type with endpoints, their custom routes file, and a seeded controller each. */
export const emitEndpointFiles = (doc: IrDocument): GeneratedFile[] =>
  doc.contentTypes.flatMap((ct) => {
    const endpoints = (doc.endpoints ?? []).filter((e) => e.contentType === ct.name);
    if (endpoints.length === 0) return [];
    return [
      routesFile(ct, endpoints),
      ...endpoints.map(
        (e): GeneratedFile => ({
          path: `src/api/${strapiNames(ct).singularName}/controllers/${hookSlug(e.name)}.ts`,
          content: controllerStub(e, ct),
          mode: "seed",
        }),
      ),
    ];
  });
