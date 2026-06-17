import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";

interface ApiNames {
  singularName: string;
  uid: string;
}

const factory = (kind: "Controller" | "Router" | "Service", uid: string): string =>
  withMarker(
    `import { factories } from "@strapi/strapi";\n\nexport default factories.createCore${kind}("${uid}");\n`,
  );

export const apiFactoryFiles = ({ singularName, uid }: ApiNames): GeneratedFile[] => {
  const base = `src/api/${singularName}`;
  return [
    { path: `${base}/controllers/${singularName}.ts`, content: factory("Controller", uid) },
    { path: `${base}/routes/${singularName}.ts`, content: factory("Router", uid) },
    { path: `${base}/services/${singularName}.ts`, content: factory("Service", uid) },
  ];
};
