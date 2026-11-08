import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";

interface ApiNames {
  singularName: string;
  uid: string;
}

const factory = (kind: "Controller" | "Router" | "Service", uid: string, config?: string): string =>
  withMarker(
    `import { factories } from "@strapi/strapi";\n\nexport default factories.createCore${kind}("${uid}"${config === undefined ? "" : `, ${config}`});\n`,
  );

/** The core controller, router and service; `routerConfig` is the router's options, if any. */
export const apiFactoryFiles = (
  { singularName, uid }: ApiNames,
  routerConfig?: string,
): GeneratedFile[] => {
  const base = `src/api/${singularName}`;
  return [
    { path: `${base}/controllers/${singularName}.ts`, content: factory("Controller", uid) },
    {
      path: `${base}/routes/${singularName}.ts`,
      content: factory("Router", uid, routerConfig),
    },
    { path: `${base}/services/${singularName}.ts`, content: factory("Service", uid) },
  ];
};
