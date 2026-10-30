import { pluralize } from "@camis/ir-core";
import {
  fieldApiName,
  type CapabilityGap,
  type Component,
  type ComponentFieldT,
  type ContentType,
  type Field,
  type IrDocument,
} from "@camis/ir-schema";
import { filamentNames } from "../names";
import { componentUid, kebab } from "./names";
import {
  listArguments,
  LOCALE_ARGUMENT,
  OPERATORS,
  PUBLICATION_ARGUMENTS,
  PUBLICATION_FILTERS,
  printDefinition,
  STATUS_ARGUMENT,
  TIMESTAMPS,
  type Argument,
  type Definition,
  type DefinitionSink,
  type Member,
} from "./graphql-sdl";
import { definePluginApis, type PluginAction } from "./graphql-plugin-schema";
import { FILE_UID } from "./media-runtime";
import { USER_UID, type WireShape } from "./wire-shape";

/**
 * Strapi 5's GraphQL schema for a project's content types, printed as webonyx's (and
 * graphql-js's) schema printer prints it: strapi-php's schema for the same types
 * (`graphql-schema.strapi-php.graphql`) is the oracle, definition for definition.
 *
 * Alongside the printed schema it returns what the runtime needs to resolve it: each root field's
 * content type and action, and each type's relations, components and zones.
 */

/** What the runtime reads: GraphQL type name → how its fields reach the REST API. */
export interface GraphqlRelation {
  type: string;
  many: boolean;
  /** The target's model, whose read grant the caller needs to see the relation at all. */
  model: string;
}
export interface GraphqlContentType {
  name: string;
  /** Strapi's uid (`api::book.book`), which a file's related entries carry as \`__type\`. */
  uid: string;
  model: string;
  /** The REST route key's API name when it is not the documentId (`options.upsertBy`). */
  routeKey: string | null;
  draftPublish: boolean;
  localized: boolean;
  relations: Record<string, GraphqlRelation>;
  components: Record<string, { type: string; repeatable: boolean }>;
  zones: string[];
}
export interface GraphqlComponent {
  name: string;
  uid: string;
  components: Record<string, { type: string; repeatable: boolean }>;
}
export interface GraphqlSchema {
  sdl: string;
  queries: [
    field: string,
    type: string,
    action: "findOne" | "find" | "connection" | "findSingle",
  ][];
  mutations: [
    field: string,
    type: string,
    action: "create" | "update" | "delete" | "updateSingle" | "deleteSingle",
  ][];
  types: GraphqlContentType[];
  components: GraphqlComponent[];
  /** Every component's GraphQL type name → its uid, for a zone's items. */
  zoneMembers: Record<string, string[]>;
  /** Plugin root fields → what the runtime answers them with. */
  plugins: [field: string, action: PluginAction][];
  /** The IR's roles as users-permissions shows them: the role's name is its type. */
  roles: GraphqlRole[];
  gaps: CapabilityGap[];
}

export interface GraphqlRole {
  type: string;
  name: string;
  description: string | null;
}

export interface GraphqlSchemaInput {
  doc: IrDocument;
  emitted: ContentType[];
  shapes: ReadonlyMap<string, WireShape>;
  media: boolean;
  roles: readonly { name: string; description?: string | undefined }[];
}

// ------------------------------------------------------------------------------------ naming

const pascal = (kebabName: string): string =>
  kebabName
    .split(/[-_.\s]+/)
    .filter((part) => part !== "")
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
const camel = (kebabName: string): string => {
  const p = pascal(kebabName);
  return p[0]!.toLowerCase() + p.slice(1);
};
/** Strapi's getTypeName: the singular name, PascalCase (`activity-session` → ActivitySession). */
const typeName = (ct: ContentType): string => pascal(kebab(ct.name));
/** Strapi's getComponentName: `shared.money` → ComponentSharedMoney. */
const componentTypeName = (component: Component): string =>
  `Component${pascal(componentUid(component))}`;
const singularField = (ct: ContentType): string => camel(kebab(ct.name));
const pluralField = (ct: ContentType): string =>
  camel(kebab(ct.names?.plural ?? pluralize(ct.name)));
const lodashSnake = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toUpperCase();

const SCALAR_DESCRIPTIONS: Record<string, string> = {
  JSON: "The `JSON` scalar type represents JSON values as specified by [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf).",
  Long: "The `BigInt` scalar type represents non-fractional signed whole numeric values.",
  DateTime:
    "A date-time string at UTC, such as 2007-12-03T10:15:30Z, compliant with the `date-time` format outlined in section 5.6 of the RFC 3339 profile of the ISO 8601 standard for representation of dates and times using the Gregorian calendar.",
  Date: "A date string, such as 2007-12-03, compliant with the `full-date` format outlined in section 5.6 of the RFC 3339 profile of the ISO 8601 standard for representation of dates and times using the Gregorian calendar.",
  Time: "A time string with format HH:mm:ss.SSS",
  I18NLocaleCode: "A string used to identify an i18n locale",
};
const BUILT_IN = new Set(["ID", "String", "Int", "Float", "Boolean"]);

const scalarOf = (type: Field["type"]): string => {
  switch (type) {
    case "integer":
      return "Int";
    case "bigInteger":
      return "Long";
    case "float":
    case "decimal":
      return "Float";
    case "boolean":
      return "Boolean";
    case "date":
      return "Date";
    case "time":
      return "Time";
    case "dateTime":
    case "timestamp":
      return "DateTime";
    case "json":
    case "blocks":
      return "JSON";
    default:
      return "String";
  }
};
const GRAPHQL_NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;

/** The upload plugin's file type, as Strapi's content API sends it. */
const UPLOAD_FILE_FIELDS: [string, string][] = [
  ["name", "String!"],
  ["alternativeText", "String"],
  ["caption", "String"],
  ["focalPoint", "JSON"],
  ["width", "Int"],
  ["height", "Int"],
  ["formats", "JSON"],
  ["hash", "String!"],
  ["ext", "String"],
  ["mime", "String!"],
  ["size", "Float!"],
  ["url", "String!"],
  ["previewUrl", "String"],
  ["provider", "String!"],
  ["provider_metadata", "JSON"],
];

class SchemaBuilder implements DefinitionSink {
  private readonly definitions = new Map<string, Definition>();
  private readonly componentsByName: Map<string, Component>;
  readonly componentMaps = new Map<string, GraphqlComponent>();
  readonly zoneMembers: Record<string, string[]> = {};

  constructor(input: GraphqlSchemaInput) {
    this.componentsByName = new Map(input.doc.components.map((c) => [c.name, c]));
  }

  define(definition: Definition): void {
    if (!this.definitions.has(definition.name)) this.definitions.set(definition.name, definition);
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  /** A definition made on first use, so the schema names only what it needs. */
  need(name: string, make: () => Definition): string {
    if (!this.definitions.has(name)) {
      this.definitions.set(name, { kind: "scalar", name });
      this.definitions.set(name, make());
    }
    return name;
  }

  scalar(name: string): string {
    if (BUILT_IN.has(name)) return name;
    const description = SCALAR_DESCRIPTIONS[name];
    return this.need(name, () => ({
      kind: "scalar",
      name,
      ...(description === undefined ? {} : { description }),
    }));
  }

  scalarFilter(scalar: string): string {
    this.scalar(scalar);
    return this.need(`${scalar}FilterInput`, () => ({
      kind: "input",
      name: `${scalar}FilterInput`,
      fields: [
        { name: "and", type: `[${scalar}]` },
        { name: "or", type: `[${scalar}]` },
        { name: "not", type: `${scalar}FilterInput` },
        ...OPERATORS.map((o) => ({ name: o, type: scalar })),
        { name: "null", type: "Boolean" },
        { name: "notNull", type: "Boolean" },
        { name: "in", type: `[${scalar}]` },
        { name: "notIn", type: `[${scalar}]` },
        { name: "between", type: `[${scalar}]` },
      ],
    }));
  }

  /** Strapi's enum for an enumeration field: ENUM_<TYPE>_<FIELD>, or a string when a value is no name. */
  enumeration(owner: string, field: Field | ComponentFieldT): string {
    if (field.type !== "enumeration" || !field.values.every((v) => GRAPHQL_NAME.test(v)))
      return "String";
    const name = `ENUM_${lodashSnake(`${owner}_${fieldApiName(field)}`)}`;
    return this.need(name, () => ({ kind: "enum", name, values: [...field.values] }));
  }

  /** A scalar field's output and input type. */
  scalarType(owner: string, field: Field | ComponentFieldT): string {
    return field.type === "enumeration"
      ? this.enumeration(owner, field)
      : this.scalar(scalarOf(field.type));
  }

  pagination(): void {
    this.need("PaginationArg", () => ({
      kind: "input",
      name: "PaginationArg",
      fields: ["page", "pageSize", "start", "limit"].map((name) => ({ name, type: "Int" })),
    }));
  }

  component(name: string): Component {
    const component = this.componentsByName.get(name);
    if (component === undefined) throw new Error(`unknown component "${name}"`);
    return component;
  }

  /** A component's type, with its id, its own components and its files; relations stay off it. */
  componentType(component: Component): string {
    const name = componentTypeName(component);
    return this.need(name, () => {
      const nested: GraphqlComponent["components"] = {};
      const fields: Member[] = [{ name: "id", type: "ID!" }];
      for (const f of component.fields) {
        const key = fieldApiName(f);
        if (f.private === true) continue;
        if (f.type === "component") {
          const target = this.component(f.component);
          nested[key] = { type: componentTypeName(target), repeatable: f.repeatable };
          fields.push(this.componentField(key, target, f.repeatable));
        } else if (f.type === "media") {
          this.uploadFile();
          fields.push({ name: key, type: f.multiple === true ? "[UploadFile]!" : "UploadFile" });
        } else if (f.type !== "relation") {
          fields.push({
            name: key,
            type: `${this.scalarType(name, f)}${f.required === true ? "!" : ""}`,
          });
        }
      }
      this.componentMaps.set(name, { name, uid: componentUid(component), components: nested });
      return { kind: "type", name, fields };
    });
  }

  componentField(key: string, component: Component, repeatable: boolean): Member {
    const type = this.componentType(component);
    if (!repeatable) return { name: key, type };
    this.pagination();
    return { name: key, args: listArguments(this.componentFilters(component)), type: `[${type}]` };
  }

  componentFilters(component: Component): string {
    const name = `${componentTypeName(component)}FiltersInput`;
    return this.need(name, () => ({
      kind: "input",
      name,
      fields: [
        ...component.fields.flatMap((f): Member[] =>
          f.private === true
            ? []
            : f.type === "component"
              ? [
                  {
                    name: fieldApiName(f),
                    type: this.componentFilters(this.component(f.component)),
                  },
                ]
              : f.type === "relation" || f.type === "media"
                ? []
                : [{ name: fieldApiName(f), type: this.scalarFilter(scalarOf(f.type)) }],
        ),
        { name: "and", type: `[${name}]` },
        { name: "or", type: `[${name}]` },
        { name: "not", type: name },
      ],
    }));
  }

  componentInput(component: Component): string {
    const name = `${componentTypeName(component)}Input`;
    return this.need(name, () => ({
      kind: "input",
      name,
      fields: [
        { name: "id", type: "ID" },
        ...component.fields.flatMap((f): Member[] => {
          if (f.type === "component") {
            const input = this.componentInput(this.component(f.component));
            return [{ name: fieldApiName(f), type: f.repeatable ? `[${input}]` : input }];
          }
          if (f.type === "media")
            return [{ name: fieldApiName(f), type: f.multiple === true ? "[ID]" : "ID" }];
          return f.type === "relation"
            ? []
            : [{ name: fieldApiName(f), type: this.scalarType(componentTypeName(component), f) }];
        }),
      ],
    }));
  }

  uploadFile(): void {
    this.scalar("DateTime");
    this.scalar("JSON");
    this.need("UploadFile", () => ({
      kind: "type",
      name: "UploadFile",
      fields: [
        { name: "documentId", type: "ID!" },
        ...UPLOAD_FILE_FIELDS.map(([name, type]) => ({ name, type })),
        { name: "related", type: "[GenericMorph]" },
        ...TIMESTAMPS.map((name) => ({ name, type: "DateTime" })),
      ],
    }));
    this.need("UploadFileFiltersInput", () => ({
      kind: "input",
      name: "UploadFileFiltersInput",
      fields: [
        { name: "documentId", type: this.scalarFilter("ID") },
        ...UPLOAD_FILE_FIELDS.map(([name, type]) => ({
          name,
          type: this.scalarFilter(type.replace("!", "")),
        })),
        ...TIMESTAMPS.map((name) => ({ name, type: this.scalarFilter("DateTime") })),
        { name: "and", type: "[UploadFileFiltersInput]" },
        { name: "or", type: "[UploadFileFiltersInput]" },
        { name: "not", type: "UploadFileFiltersInput" },
      ],
    }));
  }

  relationCollection(target: string): string {
    return this.need(`${target}RelationResponseCollection`, () => ({
      kind: "type",
      name: `${target}RelationResponseCollection`,
      fields: [{ name: "nodes", type: `[${target}!]!` }],
    }));
  }

  print(): string {
    return `${[...this.definitions.values()].map(printDefinition).join("\n\n")}\n`;
  }
}

/** A content type's fields as Strapi's content API lays them out: its own, then inverse sides. */
interface ContentField {
  field?: Field;
  key: string;
  relation?: WireShape["relations"][number];
}
const contentFields = (ct: ContentType, shape: WireShape): ContentField[] => {
  const relations = new Map(shape.relations.map((r) => [r.key, r]));
  const own = ct.fields.flatMap((f): ContentField[] => {
    const key = fieldApiName(f);
    if (f.type === "relation" || f.type === "media") {
      const relation = relations.get(key);
      // A link the wire shape leaves out (media without a media library) stays off it too.
      return relation === undefined ? [] : [{ field: f, key, relation }];
    }
    return [{ field: f, key }];
  });
  const ownKeys = new Set(own.map((o) => o.key));
  const inverse = shape.relations
    .filter((r) => !ownKeys.has(r.key) && r.kind !== "localizations")
    .map((relation): ContentField => ({ key: relation.key, relation }));
  return [...own, ...inverse];
};

const MANY = new Set(["hasMany", "belongsToMany", "localizations", "mediaMany"]);

/** What a content type's input takes for a private field, which its type and filters leave out. */
const privateInput = (
  b: SchemaBuilder,
  typeName: string,
  key: string,
  field: Field,
  relation: WireShape["relations"][number] | undefined,
): string => {
  if (relation !== undefined) return MANY.has(relation.kind) ? "[ID]" : "ID";
  if (field.type === "component") {
    const input = b.componentInput(b.component(field.component));
    return field.repeatable ? `[${input}]` : input;
  }
  if (field.type === "dynamicZone") {
    const input = `${typeName}${pascal(key)}DynamicZoneInput`;
    b.need(input, () => ({ kind: "scalar", name: input }));
    return `[${input}!]`;
  }
  return b.scalarType(typeName, field);
};

export const buildGraphqlSchema = (input: GraphqlSchemaInput): GraphqlSchema => {
  const { shapes } = input;
  const b = new SchemaBuilder(input);
  const byModel = new Map(input.emitted.map((ct) => [filamentNames(ct).model, ct]));
  const contentTypes = [...input.emitted].sort((x, y) =>
    kebab(x.name).localeCompare(kebab(y.name)),
  );
  const queryFields: Member[] = [];
  const mutationFields: Member[] = [];
  const queries: GraphqlSchema["queries"] = [];
  const mutations: GraphqlSchema["mutations"] = [];
  const types: GraphqlContentType[] = [];
  const gaps: CapabilityGap[] = [];

  b.define({ kind: "type", name: "Query", fields: queryFields });
  b.define({ kind: "type", name: "Mutation", fields: mutationFields });
  b.define({ kind: "enum", name: "PublicationStatus", values: ["DRAFT", "PUBLISHED"] });
  b.define({ kind: "enum", name: "PublicationFilter", values: PUBLICATION_FILTERS });
  b.pagination();
  if (input.media) b.uploadFile();

  /** The GraphQL type a relation reaches. */
  const targetType = (relation: WireShape["relations"][number]): string => {
    if (relation.kind === "mediaOne" || relation.kind === "mediaMany") return "UploadFile";
    if (relation.uid === USER_UID) return "UsersPermissionsUser";
    const target = byModel.get(relation.model);
    if (target === undefined) throw new Error(`unknown relation target "${relation.model}"`);
    return typeName(target);
  };

  for (const ct of contentTypes) {
    const shape = shapes.get(ct.name);
    if (shape === undefined) continue;
    const name = typeName(ct);
    const filters = `${name}FiltersInput`;
    const upsertBy = ct.fields.find((f) => f.name === ct.options?.upsertBy);
    const map: GraphqlContentType = {
      name,
      uid: `api::${kebab(ct.name)}.${kebab(ct.name)}`,
      model: shape.model,
      routeKey: upsertBy === undefined ? null : fieldApiName(upsertBy),
      draftPublish: shape.draftPublish,
      localized: shape.localized,
      relations: {},
      components: {},
      zones: [],
    };
    const typeFields: Member[] = [{ name: "documentId", type: "ID!" }];
    // A single type is never listed, so Strapi defines no filters for it (nor a collection).
    const listed = ct.kind !== "single";
    const filterFields: Member[] = [];
    const filter = (field: string, type: () => string): void => {
      if (listed) filterFields.push({ name: field, type: type() });
    };
    filter("documentId", () => b.scalarFilter("ID"));
    const inputFields: Member[] = [];

    for (const { field, key, relation } of contentFields(ct, shape)) {
      // Strapi's type and filters leave a private field out; its input still takes it.
      if (field?.private === true) {
        inputFields.push({ name: key, type: privateInput(b, name, key, field, relation) });
        continue;
      }
      if (relation !== undefined) {
        const target = targetType(relation);
        const many = MANY.has(relation.kind);
        map.relations[key] = { type: target, many, model: relation.model };
        const media = target === "UploadFile";
        if (many) {
          const args = listArguments(`${target}FiltersInput`);
          typeFields.push(
            { name: `${key}_connection`, args, type: b.relationCollection(target) },
            { name: key, args, type: `[${target}]!` },
          );
        } else {
          typeFields.push({ name: key, type: target });
        }
        if (!media) filter(key, () => `${target}FiltersInput`);
        inputFields.push({ name: key, type: many ? "[ID]" : "ID" });
        continue;
      }
      if (field === undefined) continue;
      if (field.type === "component") {
        const component = b.component(field.component);
        map.components[key] = {
          type: componentTypeName(component),
          repeatable: field.repeatable,
        };
        typeFields.push(b.componentField(key, component, field.repeatable));
        filter(key, () => b.componentFilters(component));
        const componentInput = b.componentInput(component);
        inputFields.push({
          name: key,
          type: field.repeatable ? `[${componentInput}]` : componentInput,
        });
      } else if (field.type === "dynamicZone") {
        const union = `${name}${pascal(key)}DynamicZone`;
        const members = field.components.map((c) => b.componentType(b.component(c)));
        b.need(union, () => ({ kind: "union", name: union, members: [...members, "Error"] }));
        b.need("Error", () => ({
          kind: "type",
          name: "Error",
          fields: [
            { name: "code", type: "String!" },
            { name: "message", type: "String" },
          ],
        }));
        b.need(`${union}Input`, () => ({ kind: "scalar", name: `${union}Input` }));
        b.zoneMembers[union] = members;
        map.zones.push(key);
        typeFields.push({ name: key, type: `[${union}]` });
        inputFields.push({ name: key, type: `[${union}Input!]` });
      } else {
        const type = b.scalarType(name, field);
        typeFields.push({ name: key, type: `${type}${field.required === true ? "!" : ""}` });
        filter(key, () => b.scalarFilter(scalarOf(field.type)));
        inputFields.push({ name: key, type });
      }
    }

    typeFields.push(...TIMESTAMPS.map((t) => ({ name: t, type: "DateTime" })));
    for (const t of TIMESTAMPS) filter(t, () => b.scalarFilter("DateTime"));
    if (shape.localized) {
      const args = listed ? listArguments(filters) : [];
      map.relations.localizations = { type: name, many: true, model: shape.model };
      typeFields.push(
        { name: "locale", type: "String" },
        { name: "localizations_connection", args, type: b.relationCollection(name) },
        { name: "localizations", args, type: `[${name}]!` },
      );
      filter("locale", () => b.scalarFilter("String"));
      filter("localizations", () => filters);
    }
    filter("and", () => `[${filters}]`);
    filter("or", () => `[${filters}]`);
    filter("not", () => filters);
    // Strapi's input carries a locale only on the types that keep none: it is the i18n plugin's
    // own attribute, which a localized type sets through the locale argument instead.
    inputFields.push(
      { name: "publishedAt", type: "DateTime" },
      ...(shape.localized ? [] : [{ name: "locale", type: "String" }]),
    );

    b.define({ kind: "type", name, fields: typeFields });
    b.define({ kind: "input", name: `${name}Input`, fields: inputFields });
    if (listed) {
      b.define({ kind: "input", name: filters, fields: filterFields });
      b.need(`${name}EntityResponseCollection`, () => ({
        kind: "type",
        name: `${name}EntityResponseCollection`,
        fields: [
          { name: "nodes", type: `[${name}!]!` },
          { name: "pageInfo", type: "Pagination!" },
        ],
      }));
      b.need("Pagination", () => ({
        kind: "type",
        name: "Pagination",
        fields: ["total", "page", "pageSize", "pageCount"].map((f) => ({
          name: f,
          type: "Int!",
        })),
      }));
    }
    b.need("DeleteMutationResponse", () => ({
      kind: "type",
      name: "DeleteMutationResponse",
      fields: [{ name: "documentId", type: "ID!" }],
    }));
    if (shape.localized) b.scalar("I18NLocaleCode");

    const locale = shape.localized ? [LOCALE_ARGUMENT] : [];
    const data: Argument = { name: "data", type: `${name}Input!` };
    const single = singularField(ct);
    if (listed) {
      const documentId: Argument = { name: "documentId", type: "ID!" };
      const plural = pluralField(ct);
      queryFields.push(
        { name: single, args: [documentId, ...PUBLICATION_ARGUMENTS, ...locale], type: name },
        {
          name: `${plural}_connection`,
          args: [...listArguments(filters), ...PUBLICATION_ARGUMENTS, ...locale],
          type: `${name}EntityResponseCollection`,
        },
        {
          name: plural,
          args: [...listArguments(filters), ...PUBLICATION_ARGUMENTS, ...locale],
          type: `[${name}]!`,
        },
      );
      queries.push(
        [single, name, "findOne"],
        [`${plural}_connection`, name, "connection"],
        [plural, name, "find"],
      );
      mutationFields.push(
        { name: `create${name}`, args: [STATUS_ARGUMENT, data, ...locale], type: name },
        { name: `update${name}`, args: [documentId, STATUS_ARGUMENT, data, ...locale], type: name },
        { name: `delete${name}`, args: [documentId, ...locale], type: "DeleteMutationResponse" },
      );
      mutations.push(
        [`create${name}`, name, "create"],
        [`update${name}`, name, "update"],
        [`delete${name}`, name, "delete"],
      );
    } else {
      // Strapi's single type: its one entry, found, made or updated, and deleted by its locale.
      queryFields.push({ name: single, args: [...PUBLICATION_ARGUMENTS, ...locale], type: name });
      queries.push([single, name, "findSingle"]);
      mutationFields.push(
        { name: `update${name}`, args: [STATUS_ARGUMENT, data, ...locale], type: name },
        { name: `delete${name}`, args: locale, type: "DeleteMutationResponse" },
      );
      mutations.push(
        [`update${name}`, name, "updateSingle"],
        [`delete${name}`, name, "deleteSingle"],
      );
    }
    types.push(map);
  }
  if (input.media) {
    types.push({
      name: "UploadFile",
      uid: FILE_UID,
      model: "File",
      routeKey: null,
      draftPublish: false,
      localized: false,
      relations: {},
      components: {},
      zones: [],
    });
  }
  const plugins = definePluginApis(b, {
    media: input.media,
    localized: types.some((t) => t.localized),
  });
  queryFields.unshift(...plugins.queries);
  mutationFields.push(...plugins.mutations);
  if (input.media) b.define(genericMorph(b, types));
  gaps.push(
    {
      feature: "graphqlRoleMutations",
      location: {},
      severity: "downgrade",
      message:
        "Roles are the IR's: createUsersPermissionsRole, updateUsersPermissionsRole and deleteUsersPermissionsRole are refused, as the REST role routes are.",
    },
    {
      feature: "graphqlRolePermissions",
      location: {},
      severity: "downgrade",
      message:
        "A role's permissions are its IR grants, which users-permissions' permission rows cannot express: UsersPermissionsRole.permissions is refused.",
    },
  );

  return {
    sdl: b.print(),
    queries,
    mutations,
    types,
    components: [...b.componentMaps.values()].sort((x, y) => x.name.localeCompare(y.name)),
    zoneMembers: b.zoneMembers,
    plugins: plugins.fields,
    roles: input.roles.map(graphqlRole),
    gaps,
  };
};

/**
 * Strapi's union of everything a file can be linked from, in its registration order: components,
 * then the plugins' types, then the content types by uid.
 */
const genericMorph = (b: SchemaBuilder, types: GraphqlContentType[]): Definition => ({
  kind: "union",
  name: "GenericMorph",
  members: [
    ...[...b.componentMaps.keys()].sort(),
    ...PLUGIN_MORPH_MEMBERS.filter((name) => b.has(name)),
    ...types.map((t) => t.name).filter((name) => !PLUGIN_MORPH_MEMBERS.includes(name)),
  ],
});
const PLUGIN_MORPH_MEMBERS = [
  "UploadFile",
  "I18NLocale",
  "UsersPermissionsPermission",
  "UsersPermissionsRole",
  "UsersPermissionsUser",
];

/** Strapi's own two roles keep the descriptions users-permissions gives them. */
const ROLE_DESCRIPTIONS: Record<string, string> = {
  authenticated: "Default role given to authenticated user.",
  public: "Default role given to unauthenticated user.",
};
const graphqlRole = (role: { name: string; description?: string | undefined }): GraphqlRole => ({
  type: role.name,
  name: role.name[0]!.toUpperCase() + role.name.slice(1),
  description: role.description ?? ROLE_DESCRIPTIONS[role.name] ?? null,
});
