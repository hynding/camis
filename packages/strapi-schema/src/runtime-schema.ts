import { normalize } from "@camis/ir-core";
import type { ContentType, IrDocument } from "@camis/ir-schema";
import { componentSchema } from "./component-schema";
import { componentCategory, componentUids, kebab, strapiNames } from "./names";
import PLUGIN_SCHEMAS from "./plugin-schemas.json";
import { synthesizedInverses } from "./relations";
import { contentTypeSchema } from "./schema";

/** One schema as a running Strapi holds it, keyed as `strapi export` writes it. */
export type RuntimeSchema = Record<string, unknown> & { uid: string };

const USER_UID = "plugin::users-permissions.user";

/** `upperFirst(camelCase(name))`, as Strapi derives a model's globalId. */
const pascal = (name: string): string =>
  name
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part !== "")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");

const adminRelation = {
  type: "relation",
  relation: "oneToOne",
  target: "admin::user",
  configurable: false,
  writable: false,
  visible: false,
  useJoinTable: false,
  private: true,
};

/** What Strapi's loader adds to every content type: timestamps, publication, authors, locale. */
const systemAttributes = (uid: string, table: string, localized: boolean) => ({
  createdAt: { type: "datetime" },
  updatedAt: { type: "datetime" },
  publishedAt: { type: "datetime", configurable: false, writable: true, visible: true },
  createdBy: adminRelation,
  updatedBy: adminRelation,
  locale: {
    writable: true,
    private: !localized,
    configurable: false,
    visible: false,
    type: "string",
  },
  localizations: {
    type: "relation",
    relation: "oneToMany",
    target: uid,
    writable: false,
    private: !localized,
    configurable: false,
    visible: false,
    unstable_virtual: true,
    joinColumn: { name: "document_id", referencedColumn: "document_id", referencedTable: table },
  },
});

const contentTypeRuntime = (
  ct: ContentType,
  inverses: Record<string, unknown>,
  builtinUsers: ReadonlySet<string>,
  uids: ReadonlyMap<string, string>,
): RuntimeSchema => {
  const names = strapiNames(ct);
  const file = contentTypeSchema(ct, inverses, builtinUsers, uids);
  return {
    collectionName: names.collectionName,
    info: file.info,
    options: { ...(file.options as object), draftAndPublish: ct.options?.draftPublish === true },
    pluginOptions: file.pluginOptions,
    attributes: {
      ...(file.attributes as object),
      ...systemAttributes(names.uid, names.collectionName, ct.options?.localized === true),
    },
    kind: file.kind,
    modelType: "contentType",
    modelName: names.singularName,
    uid: names.uid,
    globalId: pascal(names.singularName),
  };
};

/**
 * Every schema a Strapi 5 instance for this IR holds, in the order its export lists them: the
 * plugins' content types, the project's, the admin's, then the components. The plugins' and the
 * admin's are Strapi's own (`plugin-schemas.json`, recorded from strapi-php), except that
 * Strapi's user gains the inverse attributes an IR relation names on it.
 */
export const runtimeSchemas = (input: IrDocument): RuntimeSchema[] => {
  const doc = normalize(input);
  const inverses = synthesizedInverses(doc);
  const builtinUsers = new Set(
    doc.contentTypes.filter((ct) => ct.builtin === "user").map((ct) => ct.name),
  );
  const userInverses = Object.assign({}, ...[...builtinUsers].map((n) => inverses.get(n) ?? {}));
  const uids = componentUids(doc.components);
  const fixed = (PLUGIN_SCHEMAS as RuntimeSchema[]).map((schema) =>
    schema.uid === USER_UID
      ? { ...schema, attributes: { ...(schema.attributes as object), ...userInverses } }
      : schema,
  );
  const project = doc.contentTypes
    .filter((ct) => ct.builtin === undefined)
    .map((ct) => contentTypeRuntime(ct, inverses.get(ct.name) ?? {}, builtinUsers, uids))
    .sort((a, b) => a.uid.localeCompare(b.uid));
  const components = doc.components
    .map((component): RuntimeSchema => {
      const file = componentSchema(component, builtinUsers, uids);
      const uid = uids.get(component.name)!;
      const category = componentCategory(component);
      return {
        collectionName: file.collectionName,
        info: file.info,
        options: file.options,
        pluginOptions: {},
        attributes: file.attributes,
        modelType: "component",
        modelName: kebab(component.name),
        uid,
        globalId: `Component${pascal(category)}${pascal(kebab(component.name))}`,
      };
    })
    .sort((a, b) => a.uid.localeCompare(b.uid));
  const admin = fixed.filter((s) => s.uid.startsWith("admin::"));
  return [
    ...fixed.filter((s) => !s.uid.startsWith("admin::")),
    ...project,
    ...admin,
    ...components,
  ];
};
