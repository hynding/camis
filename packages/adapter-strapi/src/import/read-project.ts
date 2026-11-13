import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapabilityGapReport, IrDocument, Result } from "@camis/ir-schema";
import { customCodeGaps, type ProjectFile } from "./custom-code";
import type { ImportOptions } from "./import-document";
import { importDocument } from "./import-document";
import { importRouters, type RouterImport } from "./router-config";
import { importEndpoints } from "./endpoints";
import { validate } from "@camis/ir-core";

const SCHEMAS = ["src/api/*/content-types/*/schema.json", "src/components/*/*.json"];
const CODE = [
  "src/**/*.{js,cjs,mjs,jsx,ts,tsx,php}",
  "config/**/*.{js,cjs,mjs,ts,php}",
  "src/plugins/*/package.json",
];

const inDependencies = (path: string): boolean => path.split(/[\\/]/).includes("node_modules");

const read = async (dir: string, patterns: string[]): Promise<ProjectFile[]> => {
  const files: ProjectFile[] = [];
  for (const pattern of patterns) {
    for await (const entry of glob(pattern, { cwd: dir, exclude: inDependencies })) {
      files.push({
        path: entry.split("\\").join("/"),
        content: await readFile(join(dir, entry), "utf8"),
      });
    }
  }
  return files;
};

export const readStrapiProject = async (
  dir: string,
  opts: ImportOptions = {},
): Promise<{ document: Result<IrDocument>; gaps: CapabilityGapReport }> => {
  const imported = importDocument(await read(dir, SCHEMAS), opts);
  const files = await read(dir, CODE);
  const code = customCodeGaps(files);
  const gaps = [...imported.gaps.gaps, ...code];
  if (!imported.document.ok) return { ...imported, gaps: { ...imported.gaps, gaps } };
  const routers = importRouters(files, imported.document.value);
  const endpoints = importEndpoints(files, imported.document.value);
  const document = withRouters(imported.document.value, routers);
  return {
    document: validate(
      endpoints.endpoints.length > 0 ? { ...document, endpoints: endpoints.endpoints } : document,
    ),
    gaps: {
      ...imported.gaps,
      gaps: [
        // A routes file read whole is reported by what its endpoints cannot carry.
        ...gaps.filter(
          (g) => g.feature !== "customRoutes" || !endpoints.read.has(g.location.file ?? ""),
        ),
        ...routers.gaps,
        ...endpoints.gaps,
      ],
    },
  };
};

/** The document with the routes, policies and middlewares its core routers declare. */
const withRouters = (doc: IrDocument, routers: RouterImport): IrDocument => ({
  ...doc,
  contentTypes: doc.contentTypes.map((ct) => {
    const apiActions = routers.apiActions.get(ct.name);
    const publicApiActions = routers.publicApiActions.get(ct.name);
    if (apiActions === undefined && publicApiActions === undefined) return ct;
    return {
      ...ct,
      options: {
        ...ct.options,
        ...(apiActions === undefined ? {} : { apiActions }),
        ...(publicApiActions === undefined ? {} : { publicApiActions }),
      },
    };
  }),
  ...(routers.policies.length > 0 ? { policies: routers.policies } : {}),
  ...(routers.middlewares.length > 0 ? { middlewares: routers.middlewares } : {}),
});
