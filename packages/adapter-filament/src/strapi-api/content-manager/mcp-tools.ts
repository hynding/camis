import type { IrDocument } from "@camis/ir-schema";
import { runtimeSchemas, type RuntimeSchema } from "@camis/strapi-schema";
import { z } from "zod/v4";
import { PHP_FLOAT_DIGITS } from "../../decimals";

/**
 * The content-manager tools of Strapi 5's MCP server, as its `tools/list` describes them: per
 * displayed content type, list/get/create/update/delete (a single type: get/write/delete), plus
 * publish/unpublish/discard_draft under draft & publish. A port of Strapi's
 * `server/src/mcp/derive-content-type-mcp-tools.ts` and its schemas, built with Zod 4 and
 * converted as the MCP SDK converts them, so the JSON Schemas are Strapi's own. camis grants no
 * per-field or per-locale permissions, so each schema is the one a token holding the action on
 * every field and locale sees; only a localized type's locale names the installed locales, which
 * the app fills in when it serves the list.
 */

type Attribute = Record<string, unknown>;
type Attributes = Record<string, Attribute>;

export interface McpPolicy {
  action: string;
  /** Left out for an action on no content type, as the Media Library's are. */
  subject?: string;
}

/** Strapi's own words where Zod's would differ: for a refused key, and a failed pattern. */
export interface McpMessages {
  keys?: { keys: string[]; message: string }[];
  patterns?: Record<string, string>;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /** Every one must be held for the tool to be listed or called. */
  policies: McpPolicy[];
  /** True when the input's `locale` is the installed locales' enum, filled in at runtime. */
  localized: boolean;
  /** The content type the tool works on, and what it does to it. */
  uid: string;
  operation: string;
  messages?: McpMessages;
}

const EXPLORER = "plugin::content-manager.explorer.";
const ACTIONS = {
  read: `${EXPLORER}read`,
  create: `${EXPLORER}create`,
  update: `${EXPLORER}update`,
  delete: `${EXPLORER}delete`,
  publish: `${EXPLORER}publish`,
  unpublish: `${EXPLORER}publish`,
  discard: `${EXPLORER}update`,
} as const;
type ActionName = keyof typeof ACTIONS;

/** The attributes Strapi's admin permissions never name: no token may read or write them. */
const SYSTEM_FIELDS = new Set(["createdAt", "updatedAt", "publishedAt", "createdBy", "updatedBy"]);

/** Attributes `isWritableAttribute` refuses, besides those marked `writable: false`. */
const NON_WRITABLE = new Set([
  "id",
  "documentId",
  "createdAt",
  "updatedAt",
  "publishedAt",
  "createdBy",
  "updatedBy",
]);

const SCALAR_ATTRIBUTE_TYPES = new Set([
  "string",
  "text",
  "richtext",
  "email",
  "password",
  "uid",
  "integer",
  "biginteger",
  "decimal",
  "float",
  "boolean",
  "date",
  "datetime",
  "time",
  "timestamp",
  "enumeration",
]);

const FILTER_OPERATORS = [
  "$eq",
  "$eqi",
  "$ne",
  "$nei",
  "$in",
  "$notIn",
  "$lt",
  "$lte",
  "$gt",
  "$gte",
  "$between",
  "$contains",
  "$notContains",
  "$containsi",
  "$notContainsi",
  "$startsWith",
  "$startsWithi",
  "$endsWith",
  "$endsWithi",
  "$null",
  "$notNull",
];

const MANY_RELATION_TYPES = new Set([
  "oneToMany",
  "manyToMany",
  "manyWay",
  "morphToMany",
  "morphMany",
]);

const OPERATION_NOTES: Record<string, string> = {
  write:
    " Creates or updates the single-type document. If no document exists, creates one; otherwise updates the existing draft.",
  publish:
    " Operates on an existing document by documentId and may return a different numeric id for the published version row.",
  unpublish:
    " Operates on an existing document by documentId and may return a different numeric id for the draft version row.",
  discard_draft:
    " Operates on an existing document by documentId; treat documentId as the stable identity.",
};

/** `api::article.article` → `article`, `api::writer.editor` → `writer_editor`, a plugin's → `plugin-ns_model`. */
export const slugifyUidForMcpToolName = (uid: string): string => {
  const [namespace = "", modelName = ""] = uid.split("::");
  const parts = modelName.split(".").map((p) => p.toLowerCase());
  if (namespace === "api") return parts[0] === parts[1] ? parts[0]! : parts.join("_");
  return `${namespace.toLowerCase()}-${parts.join("_")}`;
};

const enumValues = (attribute: Attribute): [string, ...string[]] | null => {
  const values = attribute.enum;
  return Array.isArray(values) && values.length > 0
    ? (values.map(String) as [string, ...string[]])
    : null;
};

// --- input schemas (input-schemas.ts) ---------------------------------------------------------

const statusSchema = () =>
  z
    .enum(["draft", "published"])
    .optional()
    .describe('Document status. Defaults to "draft" when draftAndPublish is enabled.');
const documentIdSchema = () =>
  z
    .string()
    .min(1)
    .describe(
      'Stable document ID (e.g. "z7v8zma53x01r6oceimv922b"). Use this as the canonical identifier across draft/published versions; numeric "id" can differ per version row.',
    );
const pageSchema = () =>
  z.number().int().min(1).optional().describe("Page number (1-indexed, default: 1).");
const pageSizeSchema = () =>
  z.number().int().min(1).max(100).optional().describe("Items per page (default: 25, max: 100).");

// A localized type's locale is the installed locales' enum, known only at runtime: a placeholder
// the app replaces. Any other type ignores the locale.
const LOCALE_PLACEHOLDER = "camis:locale";
const localeSchema = (localized: boolean) =>
  localized
    ? z.string().optional().describe(LOCALE_PLACEHOLDER)
    : z.string().optional().describe("This content type is not localized. Locale is ignored.");

// --- sort and filters (sort-schema.ts, filters-schema.ts) --------------------------------------

const scalarKeys = (attributes: Attributes, permitted: ReadonlySet<string>): string[] =>
  Object.entries(attributes)
    .filter(
      ([key, a]) =>
        SCALAR_ATTRIBUTE_TYPES.has(a.type as string) && a.private !== true && permitted.has(key),
    )
    .map(([key]) => key);

const sortSchema = (attributes: Attributes, permitted: ReadonlySet<string>) => {
  const keys = scalarKeys(attributes, permitted);
  if (keys.length === 0) return z.never();
  const direction = z.enum(["asc", "desc"]);
  const sortObject = z.strictObject(Object.fromEntries(keys.map((k) => [k, direction.optional()])));
  const sortString = z.string().refine((value) => {
    const match = /^([^:]+):(asc|desc)$/.exec(value);
    return match === null || keys.includes(match[1]!);
  });
  return z
    .union([sortString, z.array(sortString), sortObject, z.array(sortObject)])
    .optional()
    .describe(
      `Sort expression. String: "field:asc". Array: ["field:asc"]. Object: { field: "asc" }. Valid fields: ${keys.join(", ")}.`,
    );
};

/** A decimal whose column (Strapi's column settings) keeps more digits than a PHP float carries. */
const exactDecimal = (attribute: Attribute): boolean => {
  const column = attribute.column as { args?: unknown[] } | undefined;
  const precision = column?.args?.[0];
  return typeof precision === "number" && precision > PHP_FLOAT_DIGITS;
};

const filterValue = (attribute: Attribute): z.ZodType => {
  if (exactDecimal(attribute)) return z.union([z.string(), z.number(), z.array(z.string())]);
  switch (attribute.type) {
    case "integer":
    case "biginteger":
    case "decimal":
    case "float":
      return z.union([z.number(), z.array(z.number())]);
    case "boolean":
      return z.boolean();
    case "enumeration": {
      const values = enumValues(attribute);
      return values === null
        ? z.union([z.string(), z.array(z.string())])
        : z.union([z.enum(values), z.array(z.enum(values))]);
    }
    default:
      return z.union([z.string(), z.array(z.string()), z.null()]);
  }
};

const filtersSchema = (attributes: Attributes, permitted: ReadonlySet<string>) => {
  const keys = scalarKeys(attributes, permitted);
  if (keys.length === 0) return z.never();
  const fields = Object.fromEntries(
    keys.map((key) => {
      const value = filterValue(attributes[key]!);
      const operators = Object.fromEntries(FILTER_OPERATORS.map((op) => [op, value.optional()]));
      return [key, z.union([value, z.object(operators)]).optional()];
    }),
  );
  const filters: z.ZodType = z.lazy(() =>
    z.strictObject({
      $and: z.array(filters).optional(),
      $or: z.array(filters).optional(),
      $not: filters.optional(),
      ...fields,
    }),
  );
  return filters
    .optional()
    .describe(
      `Filter object. Supports logical operators ($and, $or, $not) and field operators ($eq, $ne, $in, $contains, $gt, $lt, etc.). Valid fields: ${keys.join(", ")}.`,
    );
};

// --- data (data-schema.ts, blocks-schema.ts) ---------------------------------------------------

const textNode = z
  .object({
    type: z.literal("text"),
    text: z.string().describe("The text content."),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    code: z.boolean().optional(),
  })
  .describe("A text node with optional formatting marks.");
const linkNode = z
  .object({
    type: z.literal("link"),
    url: z.string().describe("The URL the link points to."),
    children: z.array(textNode).min(1),
  })
  .describe("An inline link node. Children must be text nodes.");
const inlineNode = z.discriminatedUnion("type", [textNode, linkNode]);
const listItem = z.object({
  type: z.literal("list-item"),
  children: z.array(inlineNode).min(1),
});
const listNode: z.ZodType = z.object({
  type: z.literal("list"),
  format: z.enum(["ordered", "unordered"]),
  indentLevel: z.number().optional(),
  children: z
    .array(z.lazy(() => z.union([listItem, listNode])))
    .min(1)
    .describe("Children must be list-item or nested list nodes."),
});
const blocksSchema = z
  .array(
    z.union([
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("paragraph"), children: z.array(inlineNode).min(1) }),
        z.object({
          type: z.literal("heading"),
          level: z.union([1, 2, 3, 4, 5, 6].map((n) => z.literal(n))),
          children: z.array(inlineNode).min(1),
        }),
        z.object({ type: z.literal("quote"), children: z.array(inlineNode).min(1) }),
        z.object({
          type: z.literal("code"),
          language: z
            .string()
            .nullable()
            .optional()
            .describe('Programming language identifier (e.g. "javascript", "python").'),
          children: z.array(textNode).min(1),
        }),
        z.object({
          type: z.literal("image"),
          image: z
            .object({
              name: z.string(),
              alternativeText: z.string().nullable().optional(),
              url: z.string(),
              caption: z.string().nullable().optional(),
              width: z.number(),
              height: z.number(),
              formats: z.record(z.string(), z.unknown()).nullable().optional(),
              hash: z.string(),
              ext: z.string(),
              mime: z.string(),
              size: z.number(),
              previewUrl: z.string().nullable().optional(),
              provider: z.string(),
              provider_metadata: z.unknown().nullable().optional(),
              createdAt: z.string(),
              updatedAt: z.string(),
            })
            .describe(
              "An existing media asset. Use media tools to retrieve this data — MCP cannot upload files.",
            ),
          children: z.array(z.object({ type: z.literal("text"), text: z.literal("") })).length(1),
        }),
      ]),
      listNode,
    ]),
  )
  .describe("An array of block nodes representing structured rich text content.");

const relationInput = (attribute: Attribute): z.ZodType => {
  const documentId = z
    .string()
    .min(1)
    .describe('Strapi document ID (e.g. "z7v8zma53x01r6oceimv922b").');
  const longHand = z.strictObject({
    documentId,
    locale: z.string().optional().describe("Target locale. Defaults to source document locale."),
    status: z
      .enum(["draft", "published"])
      .optional()
      .describe("Target version status. Defaults based on draftAndPublish config."),
  });
  if (!String(attribute.relation ?? "").endsWith("ToMany")) {
    return z.union([documentId, longHand, z.null().describe("Set to null to clear the relation.")]);
  }
  const entry = z.union([documentId, longHand]);
  const position = z.strictObject({
    before: z.string().optional().describe("Document ID to insert before."),
    after: z.string().optional().describe("Document ID to insert after."),
    start: z.boolean().optional().describe("Insert at start of list."),
    end: z.boolean().optional().describe("Insert at end of list (default)."),
  });
  const connectEntry = z.strictObject({
    documentId,
    locale: z.string().optional(),
    status: z.enum(["draft", "published"]).optional(),
    position: position.optional().describe("Ordering hint. Default: { end: true }."),
  });
  return z
    .strictObject({
      connect: z
        .array(z.union([documentId, connectEntry]))
        .optional()
        .describe(
          "Add relations. Each entry: documentId string, or { documentId, locale?, status?, position? }.",
        ),
      disconnect: z
        .array(entry)
        .optional()
        .describe(
          "Remove relations. Each entry: documentId string, or { documentId, locale?, status? }.",
        ),
      set: z
        .union([z.array(entry), z.null()])
        .optional()
        .describe(
          "Replace all relations. Array replaces existing; null clears all. Mutually exclusive with connect/disconnect.",
        ),
    })
    .refine((v) => !("set" in v) || (!("connect" in v) && !("disconnect" in v)), {
      message: "set is mutually exclusive with connect and disconnect",
      path: ["set"],
    });
};

type Components = ReadonlyMap<string, RuntimeSchema>;

const sized = <T extends z.ZodArray<z.ZodType>>(schema: T, attribute: Attribute): T => {
  let s = schema;
  if (typeof attribute.min === "number") s = s.min(attribute.min) as T;
  if (typeof attribute.max === "number") s = s.max(attribute.max) as T;
  return s;
};

const componentInput = (
  components: Components,
  uid: string,
  visited: ReadonlySet<string>,
): z.ZodType => {
  const component = components.get(uid);
  if (visited.has(uid) || component === undefined) return z.record(z.string(), z.unknown());
  const inside = new Set([...visited, uid]);
  const attributes = component.attributes as Attributes;
  return z.strictObject(
    Object.fromEntries(
      Object.entries(attributes)
        .filter(([key]) => key !== "id")
        .map(([key, a]) => [key, attributeInput(components, a, inside)]),
    ),
  );
};

const attributeInput = (
  components: Components,
  attribute: Attribute,
  visited: ReadonlySet<string> = new Set(),
): z.ZodType => {
  const finish = (s: z.ZodType) => (attribute.required === true ? s : s.optional());
  const bounded = (s: z.ZodNumber) => {
    let n = s;
    if (typeof attribute.min === "number") n = n.min(attribute.min);
    if (typeof attribute.max === "number") n = n.max(attribute.max);
    return n;
  };
  switch (attribute.type) {
    case "string":
    case "text":
    case "richtext":
    case "password": {
      let s = z.string();
      if (typeof attribute.minLength === "number") s = s.min(attribute.minLength);
      if (typeof attribute.maxLength === "number") s = s.max(attribute.maxLength);
      return finish(s);
    }
    case "email":
      return finish(z.string().email());
    case "uid":
    case "biginteger":
    case "date":
    case "datetime":
    case "time":
    case "timestamp":
      return finish(z.string());
    case "integer":
      return finish(bounded(z.number().int()));
    case "decimal":
      // A decimal beyond a double is answered as a string, and taken as one or as a number.
      return finish(
        exactDecimal(attribute) ? z.union([z.string(), bounded(z.number())]) : bounded(z.number()),
      );
    case "float":
      return finish(bounded(z.number()));
    case "boolean":
      return finish(z.boolean());
    case "enumeration": {
      const values = enumValues(attribute);
      return finish(values === null ? z.string() : z.enum(values));
    }
    case "json":
      return finish(z.any());
    case "blocks":
      return finish(blocksSchema);
    case "component": {
      const schema =
        typeof attribute.component === "string"
          ? componentInput(components, attribute.component, visited)
          : z.record(z.string(), z.unknown());
      return finish(attribute.repeatable === true ? sized(z.array(schema), attribute) : schema);
    }
    case "dynamiczone":
      return finish(sized(z.array(z.any()), attribute));
    case "media":
      return finish(attribute.multiple === true ? z.array(z.any()) : z.any());
    case "relation":
      return finish(relationInput(attribute));
    default:
      return z.unknown();
  }
};

const dataSchema = (
  components: Components,
  attributes: Attributes,
  permitted: ReadonlySet<string>,
): z.ZodType =>
  z
    .strictObject(
      Object.fromEntries(
        Object.entries(attributes)
          .filter(
            ([key, a]) =>
              permitted.has(key) &&
              !NON_WRITABLE.has(key) &&
              a.writable !== false &&
              a.private !== true,
          )
          .map(([key, a]) => [key, attributeInput(components, a)]),
      ),
    )
    .describe("Document field values to write.");

// --- output (output-schemas.ts) ----------------------------------------------------------------

const relationIdentity = () =>
  z.object({
    documentId: z.string(),
    locale: z.string().optional(),
    __type: z.string().optional(),
    status: z.string().optional(),
  });

const outputAttribute = (attribute: Attribute): z.ZodType => {
  if (attribute.type !== "relation" || attribute.target === "admin::user") {
    return z.unknown().optional();
  }
  return MANY_RELATION_TYPES.has(attribute.relation as string)
    ? z.array(relationIdentity()).optional()
    : relationIdentity().nullable().optional();
};

const outputData = (attributes: Attributes, permitted: ReadonlySet<string>): z.ZodType => {
  const keys = Object.keys(attributes).filter((k) => permitted.has(k));
  if (keys.length === 0) return z.record(z.string(), z.unknown());
  return z.looseObject(Object.fromEntries(keys.map((k) => [k, outputAttribute(attributes[k]!)])));
};

const documentOutput = (attributes: Attributes, permitted: ReadonlySet<string>) =>
  z.looseObject({
    data: outputData(attributes, permitted).nullable(),
    meta: z
      .object({
        availableLocales: z.array(z.record(z.string(), z.unknown())).optional(),
        availableStatus: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .optional(),
  });

const listOutput = (attributes: Attributes, permitted: ReadonlySet<string>) =>
  z.looseObject({
    results: z.array(outputData(attributes, permitted)),
    pagination: z.object({
      page: z.number(),
      pageSize: z.number(),
      pageCount: z.number(),
      total: z.number(),
    }),
  });

const deleteOutput = () => z.looseObject({ data: z.looseObject({}).nullable() });

// --- the tools ---------------------------------------------------------------------------------

/**
 * Zod 4.1 writes a discriminated union as `oneOf`; the Zod 4.0 bundled with Zod 3.25 writes
 * `anyOf`, so it is renamed.
 */
const discriminatedAsOneOf = (context: {
  zodSchema: { _zod: { def: unknown } };
  jsonSchema: Record<string, unknown>;
}): void => {
  const def = context.zodSchema._zod.def as { type?: string; discriminator?: string };
  if (def.type === "union" && def.discriminator !== undefined && "anyOf" in context.jsonSchema) {
    context.jsonSchema.oneOf = context.jsonSchema.anyOf;
    delete context.jsonSchema.anyOf;
  }
};

/** The MCP SDK's `standardSchemaToJsonSchema`: an input schema is stamped `type: "object"`. */
export const mcpJsonSchema = (
  schema: z.ZodType,
  io: "input" | "output",
): Record<string, unknown> => {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io,
    override: discriminatedAsOneOf,
  }) as Record<string, unknown>;
  return io === "input" ? { type: "object", ...json } : json;
};

/**
 * The content-manager's attributes of a content type, as `formatAttributes` lists them: its
 * visible ones and its timestamps and creators, without morph relations.
 */
const formattedAttributes = (schema: RuntimeSchema): Attributes =>
  Object.fromEntries(
    Object.entries(schema.attributes as Attributes).filter(
      ([key, a]) =>
        (a.visible !== false || key === "createdBy" || key === "updatedBy") &&
        !(
          a.type === "relation" &&
          String(a.relation ?? "")
            .toLowerCase()
            .includes("morph")
        ),
    ),
  );

/** The attributes a token may read and write: the formatted ones but the system's. */
export const contentAttributes = (schema: RuntimeSchema): Attributes =>
  Object.fromEntries(
    Object.entries(formattedAttributes(schema)).filter(([key]) => !SYSTEM_FIELDS.has(key)),
  );

const contentTypeTools = (schema: RuntimeSchema, components: Components): McpTool[] => {
  const uid = schema.uid;
  const slug = slugifyUidForMcpToolName(uid);
  const apiID = String(schema.modelName);
  const options = (schema.options ?? {}) as Record<string, unknown>;
  const pluginOptions = (schema.pluginOptions ?? {}) as { i18n?: { localized?: boolean } };
  const localized = pluginOptions.i18n?.localized === true;
  const draftAndPublish = options.draftAndPublish === true;
  const attributes = formattedAttributes(schema);
  const permitted = new Set(Object.keys(attributes).filter((k) => !SYSTEM_FIELDS.has(k)));
  const locale = localeSchema(localized);
  const readOutput = documentOutput(attributes, permitted);
  const write = dataSchema(components, attributes, permitted);
  const tool = (
    name: string,
    operation: string,
    actions: ActionName[],
    input: z.ZodType,
    output: z.ZodType,
  ): McpTool => ({
    name,
    title: `Content: ${apiID} — ${operation}`,
    description: `Content-manager ${operation} for ${uid}.${OPERATION_NOTES[operation] ?? ""}`,
    inputSchema: mcpJsonSchema(input, "input"),
    outputSchema: mcpJsonSchema(output, "output"),
    policies: actions.map((a) => ({ action: ACTIONS[a], subject: uid })),
    localized,
    uid,
    operation,
  });
  const documentLocale = z.object({ documentId: documentIdSchema(), locale });
  const unpublishInput = (shape: Record<string, z.ZodType>) =>
    z.object({
      ...shape,
      locale,
      discardDraft: z.boolean().optional().describe("Also discard the draft when unpublishing."),
    });

  if (schema.kind === "singleType") {
    const localeOnly = z.object({ locale });
    return [
      tool(
        `get_${slug}`,
        "get",
        ["read"],
        z.object({ locale, status: statusSchema() }),
        readOutput,
      ),
      tool(
        `write_${slug}`,
        "write",
        ["create", "update"],
        z.object({ data: write, locale }),
        readOutput,
      ),
      tool(`delete_${slug}`, "delete", ["delete"], localeOnly, deleteOutput()),
      ...(draftAndPublish
        ? [
            tool(`publish_${slug}`, "publish", ["publish"], localeOnly, readOutput),
            tool(`unpublish_${slug}`, "unpublish", ["unpublish"], unpublishInput({}), readOutput),
            tool(`discard_${slug}_draft`, "discard_draft", ["discard"], localeOnly, readOutput),
          ]
        : []),
    ];
  }
  return [
    tool(
      `list_${slug}`,
      "list",
      ["read"],
      z.object({
        locale,
        status: statusSchema(),
        page: pageSchema(),
        pageSize: pageSizeSchema(),
        sort: sortSchema(attributes, permitted),
        filters: filtersSchema(attributes, permitted),
      }),
      listOutput(attributes, permitted),
    ),
    tool(
      `get_${slug}`,
      "get",
      ["read"],
      z.object({ documentId: documentIdSchema(), locale, status: statusSchema() }),
      readOutput,
    ),
    tool(`create_${slug}`, "create", ["create"], z.object({ data: write, locale }), readOutput),
    tool(
      `update_${slug}`,
      "update",
      ["update"],
      z.object({ documentId: documentIdSchema(), data: write, locale }),
      readOutput,
    ),
    tool(`delete_${slug}`, "delete", ["delete"], documentLocale, deleteOutput()),
    ...(draftAndPublish
      ? [
          tool(`publish_${slug}`, "publish", ["publish"], documentLocale, readOutput),
          tool(
            `unpublish_${slug}`,
            "unpublish",
            ["unpublish"],
            unpublishInput({ documentId: documentIdSchema() }),
            readOutput,
          ),
          tool(`discard_${slug}_draft`, "discard_draft", ["discard"], documentLocale, readOutput),
        ]
      : []),
  ];
};

const USER_UID = "plugin::users-permissions.user";

/** Strapi loads a project's APIs folder by folder, so `activity` comes before `activity-session`. */
const byApiFolder = (a: RuntimeSchema, b: RuntimeSchema): number => {
  const folder = (s: RuntimeSchema) => s.uid.split(".")[0]!;
  return folder(a) < folder(b) ? -1 : folder(a) > folder(b) ? 1 : 0;
};

/** The content types the content-manager displays, in Strapi's order: its user, then the APIs. */
export const displayedContentTypes = (doc: IrDocument): RuntimeSchema[] => {
  const schemas = runtimeSchemas(doc);
  const hasUsers = doc.contentTypes.some((ct) => ct.builtin === "user");
  const user = schemas.filter((s) => s.uid === USER_UID && hasUsers);
  const project = schemas
    .filter((s) => s.modelType === "contentType" && s.uid.startsWith("api::"))
    .sort(byApiFolder);
  return [...user, ...project];
};

/** The content-manager's MCP tools, in Strapi's order. */
export const contentManagerMcpTools = (doc: IrDocument): McpTool[] => {
  const components = new Map(
    runtimeSchemas(doc)
      .filter((s) => s.modelType === "component")
      .map((s) => [s.uid, s]),
  );
  return displayedContentTypes(doc).flatMap((s) => contentTypeTools(s, components));
};

export { LOCALE_PLACEHOLDER };
