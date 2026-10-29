import {
  fieldApiName,
  type Component,
  type ComponentFieldT,
  type ContentType,
  type Field,
  type IrDocument,
} from "@camis/ir-schema";
import { componentUid, kebab, routePath } from "./names";
import plugins from "./openapi-plugins.json";

/**
 * Strapi 5's OpenAPI 3.1 document (`strapi openapi:generate`), built at generation time from the
 * IR so the server needs no Node. Strapi derives it from Zod schemas of each content type's
 * attributes (core-api/routes/validation); this writes the JSON Schema those produce. The users
 * and permissions, upload and i18n routes carry hand-written schemas in Strapi that do not depend
 * on the project, so they come from openapi-plugins.json, recorded from strapi-php.
 *
 * Strapi gives every `publishedAt` a default that is the moment the document was written. A
 * generated file carries no timestamps, so the field keeps the `required` that default earns it
 * and goes without the default.
 */
export const OPENAPI_PATH = "public/documentation/openapi.json";

/** The Strapi release whose document this reproduces (`x-strapi-version`). */
const STRAPI_VERSION = "5.56.0";
const JSON_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const MAX_SAFE_INTEGER = 9007199254740991;
const UUID_PATTERN =
  "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$";
const EMAIL_PATTERN =
  "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$";
const USER_UID = "plugin::users-permissions.user";
const FILE_UID = "plugin::upload.file";
const BOOLEAN_LITERALS = ["0", "1", "t", "true", "f", "false"];
const PUBLICATION_FILTERS = [
  "never-published",
  "has-published-version",
  "modified",
  "unmodified",
  "never-published-document",
  "has-published-version-document",
  "published-without-draft",
  "published-with-draft",
];

type JsonSchema = Record<string, unknown>;

const PLUGIN_SCHEMAS = plugins.schemas as Record<string, JsonSchema>;

/** A content type's or component's attribute as Strapi declares it, in its schema's order. */
interface Attribute {
  name: string;
  /** Strapi's attribute type (`datetime`, `biginteger`, …). */
  type: string;
  required?: boolean;
  default?: unknown;
  /** Strapi's volatile `publishedAt` default: required, but the value is left out. */
  volatileDefault?: boolean;
  writable?: false;
  /** Set by the server, never by a request body (Strapi's timestamps). */
  system?: true;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  values?: string[];
  /** media: several files; component: repeatable. */
  many?: boolean;
  /** The uid a relation, component or media field points at. */
  target?: string;
}

export interface OpenApiInput {
  doc: IrDocument;
  emitted: ContentType[];
  versioned: ReadonlySet<string>;
  localized: ReadonlySet<string>;
  media: boolean;
  projectName: string;
}

const SCALAR = (a: Attribute) =>
  !["relation", "component", "media", "dynamiczone"].includes(a.type);

/** Strapi's `transformUidToValidOpenApiName`: `api::book.book` → ApiBookBookDocument. */
export const openApiName = (uid: string): string => {
  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const pascal = (s: string) => s.split(/[-_]/).map(capitalize).join("");
  const [namespace, rest] = uid.split("::");
  if (rest !== undefined)
    return `${capitalize(pascal(namespace!))}${rest.split(".").map(pascal).join("")}Document`;
  return `${uid.split(".").map(pascal).join("")}Entry`;
};

const STRAPI_TYPES: Record<string, string> = {
  richText: "richtext",
  bigInteger: "biginteger",
  dateTime: "datetime",
  dynamicZone: "dynamiczone",
};

class DocumentBuilder {
  private readonly schemas = new Map<string, JsonSchema>();
  private readonly byName = new Map<string, ContentType>();
  private readonly components = new Map<string, Component>();

  constructor(private readonly input: OpenApiInput) {
    for (const ct of input.doc.contentTypes) this.byName.set(ct.name, ct);
    for (const c of input.doc.components) this.components.set(c.name, c);
  }

  uid(ct: ContentType): string {
    if (ct.builtin === "user") return USER_UID;
    if (ct.builtin === "file") return FILE_UID;
    return `api::${kebab(ct.name)}.${kebab(ct.name)}`;
  }

  private targetUid(name: string): string {
    const ct = this.byName.get(name);
    return ct === undefined ? `api::${kebab(name)}.${kebab(name)}` : this.uid(ct);
  }

  /** Strapi's document leaves a private field out of every schema, input and output alike. */
  private fieldAttributes(fields: readonly (Field | ComponentFieldT)[]): Attribute[] {
    return fields
      .filter((f) => f.private !== true)
      .map((f): Attribute => {
        const a: Attribute = { name: fieldApiName(f), type: STRAPI_TYPES[f.type] ?? f.type };
        if (f.required === true) a.required = true;
        if ("default" in f && f.default !== undefined) a.default = f.default;
        if ("min" in f && f.min !== undefined) a.min = f.min;
        if ("max" in f && f.max !== undefined) a.max = f.max;
        if ("minLength" in f && f.minLength !== undefined) a.minLength = f.minLength;
        if ("maxLength" in f && f.maxLength !== undefined) a.maxLength = f.maxLength;
        if (f.type === "enumeration") a.values = f.values;
        if (f.type === "media") {
          a.target = FILE_UID;
          if (f.multiple === true) a.many = true;
        }
        if (f.type === "component") {
          const component = this.components.get(f.component);
          if (component !== undefined) a.target = componentUid(component);
          if (f.repeatable) a.many = true;
        }
        if (f.type === "relation") {
          a.target = this.targetUid(f.target);
          if (f.relationKind === "oneToMany" || f.relationKind === "manyToMany") a.many = true;
        }
        return a;
      });
  }

  /** The other side of every relation that names this type and an inverse field. */
  private inverseAttributes(ct: ContentType): Attribute[] {
    const out: Attribute[] = [];
    for (const other of this.input.doc.contentTypes.filter((c) => c.builtin === undefined))
      for (const g of other.fields) {
        if (g.type !== "relation" || g.target !== ct.name || g.inverse === undefined) continue;
        const many = g.relationKind === "manyToOne" || g.relationKind === "manyToMany";
        out.push({
          name: g.inverse,
          type: "relation",
          target: this.uid(other),
          ...(many ? { many: true } : {}),
        });
      }
    return out;
  }

  attributes(ct: ContentType): Attribute[] {
    const localized = this.input.localized.has(ct.name);
    return [
      ...this.fieldAttributes(ct.fields),
      ...(ct.builtin === undefined ? this.inverseAttributes(ct) : []),
      { name: "createdAt", type: "datetime", system: true },
      { name: "updatedAt", type: "datetime", system: true },
      { name: "publishedAt", type: "datetime", volatileDefault: true },
      ...(localized
        ? [
            { name: "locale", type: "string" },
            {
              name: "localizations",
              type: "relation",
              target: this.uid(ct),
              many: true,
              writable: false,
            } satisfies Attribute,
          ]
        : []),
    ];
  }

  /** Strapi's order: scalar attributes first, then the populatable ones. */
  private ordered(attributes: Attribute[]): Attribute[] {
    return [...attributes.filter(SCALAR), ...attributes.filter((a) => !SCALAR(a))];
  }

  private required(a: Attribute): boolean {
    return a.required === true || a.default !== undefined || a.volatileDefault === true;
  }

  /** A `$ref` to a registered schema, building it the first time it is named. */
  private ref(uid: string): JsonSchema {
    return this.refTo(openApiName(uid), uid);
  }

  private refTo(name: string, uid?: string): JsonSchema {
    if (!this.schemas.has(name)) {
      const plugin = PLUGIN_SCHEMAS[name];
      if (plugin !== undefined) {
        this.schemas.set(name, plugin);
        for (const nested of JSON.stringify(plugin).matchAll(/"#\/components\/schemas\/(\w+)"/g))
          this.refTo(nested[1]!);
      } else {
        if (uid === undefined) throw new Error(`OpenAPI: no schema is named ${name}`);
        // A placeholder first, so a type that links itself (localizations) refers to it.
        this.schemas.set(name, {});
        this.schemas.set(name, this.registered(uid));
      }
    }
    return { $ref: `#/components/schemas/${name}` };
  }

  private registered(uid: string): JsonSchema {
    const component = [...this.components.values()].find((c) => componentUid(c) === uid);
    if (component !== undefined) return { $schema: JSON_SCHEMA, ...this.entry(component) };
    const ct = this.input.doc.contentTypes.find((c) => this.uid(c) === uid);
    if (ct === undefined) throw new Error(`OpenAPI: no content type or component has uid ${uid}`);
    return { $schema: JSON_SCHEMA, ...this.document(ct) };
  }

  /** A component's entry: its attributes, without the id and document id a document carries. */
  private entry(component: Component): JsonSchema {
    const attributes = this.ordered(this.fieldAttributes(component.fields));
    const required = attributes.filter((a) => this.required(a)).map((a) => a.name);
    return {
      type: "object",
      properties: Object.fromEntries(attributes.map((a) => [a.name, this.outputSchema(a)])),
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
  }

  document(ct: ContentType): JsonSchema {
    const attributes = this.ordered(this.attributes(ct));
    return {
      type: "object",
      properties: {
        documentId: documentIdSchema(),
        id: { anyOf: [{ type: "string" }, { type: "number" }] },
        ...Object.fromEntries(attributes.map((a) => [a.name, this.outputSchema(a)])),
      },
      required: [
        "documentId",
        "id",
        ...attributes.filter((a) => this.required(a)).map((a) => a.name),
      ],
      additionalProperties: false,
    };
  }

  /** The schema a response gives an attribute (`mapAttributeToSchema`). */
  private outputSchema(a: Attribute): JsonSchema {
    const description = DESCRIPTIONS[a.type] ?? `A ${a.type} field`;
    const many = (item: JsonSchema): JsonSchema =>
      a.many === true ? { type: "array", items: item } : item;
    switch (a.type) {
      case "relation":
        return this.decorate(a, description, many(this.ref(a.target!)), false);
      case "component":
      case "media":
        return this.decorate(a, description, many(this.ref(a.target!)), false);
      case "dynamiczone":
      case "blocks":
        return this.decorate(a, description, { type: "array", items: {} }, false);
      default:
        return this.decorate(a, description, scalarSchema(a, false), true);
    }
  }

  /** The schema a request body gives an attribute (`mapAttributeToInputSchema`). */
  private inputSchema(a: Attribute): JsonSchema {
    const description =
      a.type === "integer" ? "A float field" : (DESCRIPTIONS[a.type] ?? `A ${a.type} field`);
    const many = (item: JsonSchema): JsonSchema =>
      a.many === true ? { type: "array", items: item } : item;
    switch (a.type) {
      case "relation":
        return { description, ...many(documentIdSchema(false)) };
      case "component":
      case "media":
        return { description, ...many({}) };
      case "dynamiczone":
      case "blocks":
        return { description, type: "array", items: {} };
      default:
        return this.withDefault(a, { description, ...scalarSchema(a, true) });
    }
  }

  private decorate(
    a: Attribute,
    description: string,
    schema: JsonSchema,
    defaults: boolean,
  ): JsonSchema {
    const out = { ...(a.writable === false ? { readOnly: true } : {}), description, ...schema };
    return defaults ? this.withDefault(a, out) : out;
  }

  private withDefault(a: Attribute, schema: JsonSchema): JsonSchema {
    return a.default === undefined ? schema : { default: a.default, ...schema };
  }

  build(): JsonSchema {
    const paths: Record<string, unknown> = {};
    for (const ct of this.input.emitted) Object.assign(paths, this.routes(ct));
    for (const [path, item] of Object.entries(plugins.paths as Record<string, unknown>)) {
      if (path.startsWith("/upload") && !this.input.media) continue;
      if (path.startsWith("/i18n/") && this.input.localized.size === 0) continue;
      paths[path] = item;
    }
    return {
      openapi: "3.1.0",
      info: {
        title: this.input.projectName,
        description: `API documentation for ${this.input.projectName} v1.0.0`,
        version: "1.0.0",
      },
      "x-powered-by": "strapi",
      "x-strapi-version": STRAPI_VERSION,
      servers: [{ url: "/api", description: "Default server" }],
      security: [{ bearerAuth: [] }],
      paths,
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "JWT Bearer token for authentication",
          },
        },
        schemas: Object.fromEntries([...this.schemas].sort(([x], [y]) => x.localeCompare(y))),
      },
    };
  }

  /** A content type's core routes (five, or a single type's three), as Strapi's core router declares and documents them. */
  private routes(ct: ContentType): Record<string, unknown> {
    const attributes = this.ordered(this.attributes(ct));
    const scalars = attributes.filter(SCALAR).map((a) => a.name);
    const populatable = attributes.filter((a) => !SCALAR(a)).map((a) => a.name);
    const document = this.document(ct);
    const extra = [
      ...(this.input.localized.has(ct.name) ? [localeParameter()] : []),
      ...(this.input.versioned.has(ct.name) ? draftParameters() : []),
    ];
    const singular = kebab(ct.name);
    const plural = routePath(ct);
    const operation = (method: string, byId: boolean) =>
      `${singular}/${method}/${plural.replace(/-/g, "_")}${byId ? "_by_id" : ""}`;
    const fields = fieldsParameter(scalars);
    const populate = populateParameter(populatable);
    const filters = filtersParameter(scalars);
    const sort = sortParameter(scalars);
    const writable = attributes.filter((a) => a.writable !== false && a.system !== true);
    const data = (partial: boolean): JsonSchema => {
      const required = partial ? [] : writable.filter((a) => this.required(a)).map((a) => a.name);
      return {
        type: "object",
        properties: Object.fromEntries(writable.map((a) => [a.name, this.inputSchema(a)])),
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      };
    };
    const body = (partial: boolean) => ({
      content: { "application/json": { schema: envelope(data(partial)) } },
    });
    const ok = (data: JsonSchema) => ({
      "200": {
        description: "OK",
        content: { "application/json": { schema: envelope(data) } },
      },
      ...ERROR_RESPONSES,
    });
    const tags = [singular];
    if (ct.kind === "single")
      return {
        [`/${plural}`]: {
          get: {
            operationId: operation("get", false),
            parameters: [fields, populate, filters, ...extra],
            responses: ok(document),
            tags,
          },
          put: {
            operationId: operation("put", false),
            parameters: [fields, populate, ...extra],
            responses: ok(document),
            tags,
            requestBody: body(true),
          },
          delete: {
            operationId: operation("delete", false),
            parameters: [fields, populate, ...extra],
            responses: ok(document),
            tags,
          },
        },
      };
    return {
      [`/${plural}`]: {
        get: {
          operationId: operation("get", false),
          parameters: [fields, filters, QUERY, ...PAGINATION, sort, populate, ...extra],
          responses: ok({ type: "array", items: document }),
          tags,
        },
        post: {
          operationId: operation("post", false),
          parameters: [fields, populate, ...extra],
          responses: ok(document),
          tags,
          requestBody: body(false),
        },
      },
      [`/${plural}/{id}`]: {
        get: {
          operationId: operation("get", true),
          parameters: [ID, fields, populate, filters, sort, ...extra],
          responses: ok(document),
          tags,
        },
        put: {
          operationId: operation("put", true),
          parameters: [ID, fields, populate, ...extra],
          responses: ok(document),
          tags,
          requestBody: body(true),
        },
        delete: {
          operationId: operation("delete", true),
          parameters: [ID, fields, populate, filters, ...extra],
          responses: ok(document),
          tags,
        },
      },
    };
  }
}

const DESCRIPTIONS: Record<string, string> = {
  biginteger: "A biginteger field",
  boolean: "A boolean field",
  component: "A component field",
  date: "A date field",
  datetime: "A datetime field",
  decimal: "A decimal field",
  dynamiczone: "A dynamic zone field",
  email: "An email field",
  enumeration: "An enum field",
  float: "A float field",
  integer: "An integer field",
  json: "A JSON field",
  media: "A media field",
  relation: "A relational field",
  time: "A time field",
  timestamp: "A timestamp field",
  uid: "A UID field",
};

const documentIdSchema = (described = true): JsonSchema => ({
  type: "string",
  format: "uuid",
  pattern: UUID_PATTERN,
  ...(described ? { description: "The document ID, represented by a UUID" } : {}),
});

/** Strapi's `maybeWithMinMax`: both bounds, or neither. */
const bounds = (low: string, high: string, min?: number, max?: number) =>
  min !== undefined && max !== undefined ? { [low]: min, [high]: max } : {};

/** A scalar attribute's schema; `input` is a request body's, which reads booleans as literals. */
const scalarSchema = (a: Attribute, input: boolean): JsonSchema => {
  switch (a.type) {
    case "integer":
      return {
        type: "integer",
        minimum: -MAX_SAFE_INTEGER,
        maximum: MAX_SAFE_INTEGER,
        ...bounds("minimum", "maximum", a.min, a.max),
      };
    case "float":
    case "decimal":
      return { type: "number", ...bounds("minimum", "maximum", a.min, a.max) };
    case "biginteger":
      // Strapi bounds a biginteger's string by its length, each bound on its own.
      return {
        type: "string",
        ...(a.min !== undefined ? { minLength: a.min } : {}),
        ...(a.max !== undefined ? { maxLength: a.max } : {}),
      };
    case "boolean":
      return {
        anyOf: [
          input ? { type: "string", enum: BOOLEAN_LITERALS } : { type: "boolean" },
          { type: "null" },
        ],
      };
    case "enumeration":
      return { type: "string", enum: a.values ?? [] };
    case "email":
      return {
        type: "string",
        format: "email",
        pattern: EMAIL_PATTERN,
        ...bounds("minLength", "maxLength", a.minLength, a.maxLength),
      };
    case "json":
      return {};
    case "timestamp":
      return { anyOf: [{ type: "string" }, { type: "number" }] };
    case "date":
    case "datetime":
    case "time":
      return { type: "string" };
    default:
      return { type: "string", ...bounds("minLength", "maxLength", a.minLength, a.maxLength) };
  }
};

const envelope = (data: JsonSchema): JsonSchema => ({
  $schema: JSON_SCHEMA,
  type: "object",
  properties: { data },
  required: ["data"],
  additionalProperties: false,
});

const ERROR_RESPONSES = {
  "400": { description: "Bad request" },
  "401": { description: "Unauthorized" },
  "403": { description: "Forbidden" },
  "404": { description: "Not found" },
  "500": { description: "Internal server error" },
};

const query = (name: string, schema: JsonSchema, extra: JsonSchema = {}): JsonSchema => ({
  name,
  in: "query",
  required: false,
  schema,
  ...extra,
  "x-strapi-serialize": "querystring",
});

const ID: JsonSchema = {
  name: "id",
  in: "path",
  required: true,
  schema: { $schema: JSON_SCHEMA, ...documentIdSchema() },
};

const QUERY = query("_q", { $schema: JSON_SCHEMA, type: "string" });

const PAGINATION = [
  query("pagination[withCount]", {
    description: "Include total count in response",
    type: "boolean",
  }),
  query("pagination[page]", {
    type: "integer",
    exclusiveMinimum: 0,
    maximum: MAX_SAFE_INTEGER,
    description: "Page number (1-based)",
  }),
  query("pagination[pageSize]", {
    type: "integer",
    exclusiveMinimum: 0,
    maximum: MAX_SAFE_INTEGER,
    description: "Number of entries per page",
  }),
  query("pagination[start]", {
    type: "integer",
    minimum: 0,
    maximum: MAX_SAFE_INTEGER,
    description: "Number of entries to skip",
  }),
  query("pagination[limit]", {
    type: "integer",
    exclusiveMinimum: 0,
    maximum: MAX_SAFE_INTEGER,
    description: "Maximum number of entries to return",
  }),
];

/** Zod's enum: it names its type only when it has values. */
const names = (values: string[]): JsonSchema =>
  values.length > 0 ? { type: "string", enum: values } : { enum: values };

const fieldsParameter = (scalars: string[]) =>
  query("fields", {
    $schema: JSON_SCHEMA,
    readOnly: true,
    description:
      "The fields to return, this doesn't include populatable fields like relations, components, files, or dynamic zones",
    type: "array",
    items: names(scalars),
  });

const filtersParameter = (scalars: string[]) =>
  query(
    "filters",
    {
      $schema: JSON_SCHEMA,
      type: "object",
      propertyNames: names(scalars),
      additionalProperties: {},
      description: "Filters to apply to the query",
    },
    { style: "deepObject", explode: true },
  );

const sortParameter = (scalars: string[]) => {
  const direction = {
    type: "object",
    propertyNames: names(scalars),
    additionalProperties: { type: "string", enum: ["asc", "desc"] },
  };
  return query("sort", {
    $schema: JSON_SCHEMA,
    anyOf: [
      names(scalars),
      { type: "array", items: names(scalars) },
      direction,
      { type: "array", items: direction },
    ],
    description: "Sort the result",
  });
};

const populateParameter = (populatable: string[]) =>
  query("populate", {
    $schema: JSON_SCHEMA,
    anyOf: [
      {
        readOnly: true,
        description:
          "Populate all the first level relations, components, files, and dynamic zones for the entry",
        type: "string",
        const: "*",
      },
      {
        readOnly: true,
        description: "Populate a single relation, component, file, or dynamic zone",
        ...names(populatable),
      },
      {
        type: "array",
        items: names(populatable),
        description:
          "Populate a selection of multiple relations, components, files, or dynamic zones",
      },
    ],
  });

const localeParameter = () =>
  query("locale", { $schema: JSON_SCHEMA, type: "string", description: "Select a locale" });

const draftParameters = () => [
  query("status", {
    $schema: JSON_SCHEMA,
    type: "string",
    enum: ["draft", "published"],
    description: 'Fetch documents based on their status. Default to "published" if not specified.',
  }),
  query("publicationFilter", {
    $schema: JSON_SCHEMA,
    type: "string",
    enum: PUBLICATION_FILTERS,
    description:
      "Derived publication cohort: pair-scoped (per documentId+locale), document-scoped variants (-document), or published-slice diagnostics (published-without-draft / published-with-draft)",
  }),
  query("hasPublishedVersion", {
    $schema: JSON_SCHEMA,
    anyOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }],
    description:
      "[Deprecated: prefer publicationFilter] Filter documents by whether they have a published version. Use with status=draft to find documents that have never been published",
  }),
];

/** The document, as the JSON file Swagger UI reads: two-space indented, ending in a newline. */
export const emitOpenApiDocument = (input: OpenApiInput): string =>
  `${JSON.stringify(new DocumentBuilder(input).build(), null, 2)}\n`;

export const DOCUMENTATION_PAGE_PATH = "public/documentation/index.html";

// Swagger UI from a CDN, pinned and integrity-checked: shared hosting runs no Node, and the web
// server sends both files under public/ without starting PHP.
const SWAGGER_UI = "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14";
const SWAGGER_UI_SCRIPT_INTEGRITY =
  "sha384-wmyclcVGX/WhUkdkATwhaK1X1JtiNrr2EoYJ+diV3vj4v6OC5yCeSu+yW13SYJep";
const SWAGGER_UI_STYLE_INTEGRITY =
  "sha384-wxLW6kwyHktdDGr6Pv1zgm/VGJh99lfUbzSn6HNHBENZlCN7W602k9VkGdxuFvPn";

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page at /documentation: Swagger UI reading the document beside it. */
export const emitDocumentationPage = (projectName: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(projectName)} API documentation</title>
    <link rel="stylesheet" href="${SWAGGER_UI}/swagger-ui.css" integrity="${SWAGGER_UI_STYLE_INTEGRITY}" crossorigin="anonymous">
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${SWAGGER_UI}/swagger-ui-bundle.js" integrity="${SWAGGER_UI_SCRIPT_INTEGRITY}" crossorigin="anonymous"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
      });
    </script>
  </body>
</html>
`;
