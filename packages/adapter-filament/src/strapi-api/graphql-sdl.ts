/**
 * The pieces of a printed GraphQL schema that every part of it shares: its definitions, the
 * printer (webonyx's and graphql-js's layout, which the oracle schema is printed with), and the
 * arguments Strapi's list and document fields take.
 */

export interface Argument {
  name: string;
  type: string;
  default?: string;
  description?: string;
}
export interface Member {
  name: string;
  type: string;
  args?: Argument[];
  /** An input field's default value, as printed. */
  default?: string;
  description?: string;
}
export type Definition =
  | { kind: "type" | "input"; name: string; fields: Member[] }
  | { kind: "enum"; name: string; values: string[] }
  | { kind: "union"; name: string; members: string[] }
  | { kind: "scalar"; name: string; description?: string };

/** What adds definitions to a schema: a definition made on first use, and the shared inputs. */
export interface DefinitionSink {
  define(definition: Definition): void;
  need(name: string, make: () => Definition): string;
  scalar(name: string): string;
  scalarFilter(scalar: string): string;
  pagination(): void;
  relationCollection(target: string): string;
}

// -------------------------------------------------------------------------------- printing

const printArgument = (a: Argument): string =>
  `${a.name}: ${a.type}${a.default === undefined ? "" : ` = ${a.default}`}`;

/** graphql-js's printArgs: inline unless an argument has a description. */
const printArguments = (args: Argument[]): string => {
  if (args.length === 0) return "";
  if (args.every((a) => a.description === undefined))
    return `(${args.map(printArgument).join(", ")})`;
  const lines = args.map(
    (a, i) =>
      `${a.description === undefined ? "" : `${i === 0 ? "" : "\n"}    "${a.description}"\n`}    ${printArgument(a)}`,
  );
  return `(\n${lines.join("\n")}\n  )`;
};

export const printDefinition = (d: Definition): string => {
  switch (d.kind) {
    case "scalar":
      return `${d.description === undefined ? "" : `"${d.description}"\n`}scalar ${d.name}`;
    case "enum":
      return `enum ${d.name} {\n${d.values.map((v) => `  ${v}`).join("\n")}\n}`;
    case "union":
      return `union ${d.name} = ${d.members.join(" | ")}`;
    default:
      return `${d.kind} ${d.name} {\n${d.fields
        .map(
          (f, i) =>
            `${f.description === undefined ? "" : `${i === 0 ? "" : "\n"}  "${f.description}"\n`}  ${f.name}${printArguments(f.args ?? [])}: ${f.type}${f.default === undefined ? "" : ` = ${f.default}`}`,
        )
        .join("\n")}\n}`;
  }
};

// ------------------------------------------------------------------------------- arguments

export const OPERATORS = [
  "eq",
  "eqi",
  "ne",
  "nei",
  "startsWith",
  "endsWith",
  "contains",
  "notContains",
  "containsi",
  "notContainsi",
  "gt",
  "gte",
  "lt",
  "lte",
];
export const PUBLICATION_FILTERS = [
  "NEVER_PUBLISHED",
  "HAS_PUBLISHED_VERSION",
  "MODIFIED",
  "UNMODIFIED",
  "NEVER_PUBLISHED_DOCUMENT",
  "HAS_PUBLISHED_VERSION_DOCUMENT",
  "PUBLISHED_WITHOUT_DRAFT",
  "PUBLISHED_WITH_DRAFT",
];
export const LOCALE_ARGUMENT: Argument = {
  name: "locale",
  type: "I18NLocaleCode",
  description: "The locale to use for the query",
};
export const STATUS_ARGUMENT: Argument = {
  name: "status",
  type: "PublicationStatus",
  default: "PUBLISHED",
};
export const PUBLICATION_ARGUMENTS: Argument[] = [
  STATUS_ARGUMENT,
  { name: "hasPublishedVersion", type: "Boolean" },
  { name: "publicationFilter", type: "PublicationFilter" },
];
export const listArguments = (filters: string): Argument[] => [
  { name: "filters", type: filters },
  { name: "pagination", type: "PaginationArg", default: "{  }" },
  { name: "sort", type: "[String]", default: "[]" },
];
export const TIMESTAMPS = ["createdAt", "updatedAt", "publishedAt"];
