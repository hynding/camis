import type { GeneratedFile } from "@camis/adapter-kernel";
import type { ContentType, IrDocument } from "@camis/ir-schema";
import { runtimeSchemas, strapiNames, type RuntimeSchema } from "@camis/strapi-schema";
import { filamentNames } from "../../names";
import { runtimePhp } from "../../runtime-php";
import { FILE_UID } from "../upload/media-runtime";
import { mediaMcpTools } from "../upload/mcp-tools";
import { contentAttributes, contentManagerMcpTools, displayedContentTypes } from "./mcp-tools";

/**
 * Strapi 5's MCP server (POST /mcp): clients sign in with an admin token and work on the content
 * through the content-manager's tools. The tools and their schemas, and what the app needs to
 * answer them, are one JSON file; the server and the handlers are static PHP.
 */

export const MCP_PATH = "resources/strapi/mcp.json";

type Attribute = Record<string, unknown>;

const MANY = new Set(["oneToMany", "manyToMany", "manyWay", "morphToMany", "morphMany"]);

const localizedUid = (schemas: ReadonlyMap<string, RuntimeSchema>, uid: unknown): boolean =>
  typeof uid === "string" &&
  (schemas.get(uid)?.pluginOptions as { i18n?: { localized?: boolean } } | undefined)?.i18n
    ?.localized === true;

/** What a document's field is to the handlers: where it goes in the document, and how it reads. */
const attributeEntry = (
  a: Attribute,
  schemas: ReadonlyMap<string, RuntimeSchema>,
): Record<string, unknown> => {
  const own = (a.pluginOptions as { i18n?: { localized?: boolean } } | undefined)?.i18n;
  const common = {
    ...(a.private === true ? { private: true } : {}),
    ...(own?.localized === false ? { shared: true } : {}),
  };
  switch (a.type) {
    case "relation":
      return {
        kind: "relation",
        many: MANY.has(a.relation as string),
        ...(localizedUid(schemas, a.target) ? { localizedTarget: true } : {}),
        ...common,
      };
    case "component":
    case "media":
    case "dynamiczone":
      return { kind: a.type, ...common };
    default:
      return { kind: "scalar", ...common };
  }
};

/** Strapi's populate for every relation, file and component, however deep the components go. */
const populateOf = (
  attributes: Record<string, Attribute>,
  schemas: ReadonlyMap<string, RuntimeSchema>,
  seen: ReadonlySet<string> = new Set(),
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(attributes).flatMap(([key, a]): [string, unknown][] => {
      // The serializer refuses to populate a private field: the handlers show it empty.
      if (a.private === true) return [];
      if (a.type === "relation" || a.type === "media" || a.type === "dynamiczone")
        return [[key, true]];
      if (a.type !== "component" || typeof a.component !== "string") return [];
      const component = schemas.get(a.component);
      if (component === undefined || seen.has(a.component)) return [[key, true]];
      const inner = populateOf(
        component.attributes as Record<string, Attribute>,
        schemas,
        new Set([...seen, a.component]),
      );
      return [[key, Object.keys(inner).length === 0 ? true : { populate: inner }]];
    }),
  );

const USER_UID = "plugin::users-permissions.user";

/**
 * The tools, and each content type's model, serializer and fields as the handlers read them; the
 * Media Library's first, when the project keeps one ($fileModel), as Strapi registers them first.
 */
export const emitMcpDefinitions = (
  doc: IrDocument,
  emitted: readonly ContentType[],
  fileModel?: string,
): string => {
  const schemas = new Map(runtimeSchemas(doc).map((s) => [s.uid, s]));
  const byUid = new Map(emitted.map((ct) => [strapiNames(ct).uid, ct]));
  const served = displayedContentTypes(doc).filter((s) => s.uid === USER_UID || byUid.has(s.uid));
  const types: Record<string, Record<string, unknown>> = Object.fromEntries(
    served.map((s) => {
      const ct = byUid.get(s.uid);
      const model = ct === undefined ? "User" : filamentNames(ct).model;
      const attributes = contentAttributes(s);
      return [
        s.uid,
        {
          model: `App\\Models\\${model}`,
          serializer: `App\\Http\\Serializers\\${model}Serializer`,
          kind: s.kind,
          draftAndPublish: (s.options as { draftAndPublish?: boolean }).draftAndPublish === true,
          localized: localizedUid(schemas, s.uid),
          attributes: Object.fromEntries(
            Object.entries(attributes).map(([k, a]) => [k, attributeEntry(a, schemas)]),
          ),
          populate: populateOf(attributes, schemas),
        },
      ];
    }),
  );
  const media = fileModel === undefined ? [] : mediaMcpTools();
  if (fileModel !== undefined) types[FILE_UID] = { model: `App\\Models\\${fileModel}` };
  const tools = [...media, ...contentManagerMcpTools(doc).filter((t) => t.uid in types)];
  return `${JSON.stringify({ types, tools })}\n`;
};

const php = (path: string): string => runtimePhp(new URL(`./php/${path}`, import.meta.url));

export const contentManagerMcpFiles = (
  doc: IrDocument,
  emitted: readonly ContentType[],
  fileModel?: string,
): GeneratedFile[] => [
  { path: MCP_PATH, content: emitMcpDefinitions(doc, emitted, fileModel) },
  {
    path: "app/Support/StrapiMcpContentManager.php",
    content: php("app/Support/StrapiMcpContentManager.php"),
  },
  ...(fileModel === undefined
    ? []
    : [
        {
          path: "app/Support/StrapiMcpMedia.php",
          content: runtimePhp(
            new URL("../upload/php/app/Support/StrapiMcpMedia.php", import.meta.url),
          ),
        },
      ]),
];
