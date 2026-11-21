import { readFileSync } from "node:fs";
import { withMarker, type GeneratedFile } from "@camis/adapter-kernel";
import { tsRuntimeSource } from "@camis/expr-ts";
import type { Expression } from "@camis/expr";
import type { RecordFilter } from "@camis/permissions";
import type {
  ApiEnforcement,
  ApiHolder,
  ApiHolderLink,
  ApiHolding,
  ApiTypeRules,
} from "./api-enforcement";
import type { ApiMediaHolder, ApiUploads } from "./api-upload-enforcement";
import { handlerBody } from "./conditions";

export const API_CONDITIONS_PATH = "src/permissions/api-conditions.ts";
export const API_CONTROLLER_PATH = "src/permissions/api-controller.ts";
export const API_UPLOADS_PATH = "src/permissions/api-uploads.ts";
export const API_UPLOAD_CONTROLLER_PATH = "src/permissions/api-upload-controller.ts";
export const UPLOAD_EXTENSION_PATH = "src/extensions/upload/strapi-server.ts";

const runtime = (name: string): string =>
  readFileSync(new URL(`./runtime/${name}`, import.meta.url), "utf8");

/** The decisions' module body: its Value type comes from the Ring 1 runtime above it. */
const decisionsSource = (): string =>
  runtime("api-conditions.ts").replace(/^import type \{[^}]+\} from "@camis\/expr";\n\n?/m, "");

const key = (name: string): string => JSON.stringify(name);

const holding = (uid: string, h: ApiHolding): string =>
  h === true
    ? "true"
    : `[${h.map((name) => `CONDITIONS[${key(uid)}]![${key(name)}]!`).join(", ")}]`;

const list = (items: readonly string[]): string => `[${items.map(key).join(", ")}]`;

const typeRules = (t: ApiTypeRules): string => {
  const variables = Object.entries(t.variables)
    .map(
      ([name, v]) =>
        `      ${key(name)}: { field: ${key(v.field)}, relation: ${String(v.relation)} },`,
    )
    .join("\n");
  const roles = Object.keys(t.roles)
    .sort()
    .map((role) => {
      const rules = t.roles[role]!;
      const actions = (["read", "create", "update", "delete"] as const)
        .filter((a) => rules[a] !== undefined)
        .map((a) => `${a}: ${holding(t.uid, rules[a]!)}`);
      const lines = [...actions, `assign: ${list(rules.assign)}`].map((l) => `        ${l},`);
      return `      ${key(role)}: {\n${lines.join("\n")}\n      },`;
    })
    .join("\n");
  const defaults = Object.entries(t.defaults)
    .map(([name, value]) => `${key(name)}: ${JSON.stringify(value)}`)
    .join(", ");
  const relations = Object.entries(t.relations)
    .map(
      ([attribute, r]) =>
        `      ${key(attribute)}: { target: ${key(r.target)}, mirrored: ${String(r.mirrored)}, toOne: ${String(r.toOne)}, exclusive: ${String(r.exclusive)} },`,
    )
    .join("\n");
  return `  ${key(t.uid)}: {
    own: ${String(t.own)},
    defaults: {${defaults === "" ? "" : ` ${defaults} `}},
    relations: {${relations === "" ? "" : `\n${relations}\n    `}},
    variables: {${variables === "" ? "" : `\n${variables}\n    `}},
    open: ${list(t.open)},
    assign: ${list(t.assign)},
    admins: ADMIN_ROLES,
    roles: {${roles === "" ? "" : `\n${roles}\n    `}},
  },`;
};

/** A Ring 1 predicate as a test: true only when it evaluates to true, so an error denies. */
const test = (predicate: Expression, indent: string): string => `(data) => {
${indent}  const result = ${handlerBody(predicate)};
${indent}  return result.ok === true && result.value === true;
${indent}}`;

/** A row filter as code: its caller parts become Ring 1 tests. */
const filterSource = (filter: RecordFilter): string => {
  if (filter.kind === "caller")
    return `{ kind: "caller", test: ${test(filter.expression, "    ")} }`;
  if (filter.kind === "eq") return JSON.stringify(filter);
  return `{ kind: ${JSON.stringify(filter.kind)}, args: [${filter.args.map(filterSource).join(", ")}] }`;
};

const conditionsSource = (t: ApiTypeRules): string => {
  const conditions = t.conditions
    .map(
      (c) => `    ${key(c.name)}: {
      test: ${test(c.predicate, "      ")},
      filter: ${c.filter === null ? "null" : filterSource(c.filter)},
    },`,
    )
    .join("\n");
  return `  ${key(t.uid)}: {${conditions === "" ? "" : `\n${conditions}\n  `}},`;
};

const holderLink = (link: ApiHolderLink): string => {
  if ("relation" in link) return `{ relation: ${key(link.relation)} }`;
  if ("component" in link) return `{ component: ${key(link.component)} }`;
  if ("media" in link) return "{ media: true }";
  return `{ zone: ${list(link.zone)} }`;
};

const holdersSource = (holders: Record<string, ApiHolder>): string =>
  Object.entries(holders)
    .map(([uid, holder]) => {
      const links = Object.entries(holder.links)
        .map(([attribute, link]) => `      ${key(attribute)}: ${holderLink(link)},`)
        .join("\n");
      return `  ${key(uid)}: {
    populatable: ${list(holder.populatable)},
    links: {
${links}
    },
  },`;
    })
    .join("\n");

const mediaHolder = (holder: ApiMediaHolder): string => {
  const nested = Object.entries(holder.nested)
    .map(
      ([attribute, link]) =>
        `${key(attribute)}: ${"component" in link ? `{ component: ${key(link.component)} }` : `{ zone: ${list(link.zone)} }`}`,
    )
    .join(", ");
  return `{ fields: ${list(holder.fields)}, nested: {${nested === "" ? "" : ` ${nested} `}} }`;
};

const uploadsSource = (uploads: ApiUploads): string => {
  const holders = Object.entries(uploads.holders)
    .map(([uid, holder]) => `    ${key(uid)}: ${mediaHolder(holder)},`)
    .join("\n");
  const grants = Object.entries(uploads.grants)
    .map(([uid, g]) => `    ${key(uid)}: { read: ${list(g.read)}, update: ${list(g.update)} },`)
    .join("\n");
  return `
/** What the upload API's checks read: media fields, and who holds each type outright. */
const UPLOADS: Uploads = {
  admins: ADMIN_ROLES,
  holders: {
${holders}
  },
  grants: {
${grants}
  },
};
`;
};

const rulesSource = (enforcement: ApiEnforcement): string => {
  const admins = enforcement.types[0]?.admins ?? enforcement.uploads?.admins ?? [];
  const holders = holdersSource(enforcement.holders);
  const uploads = enforcement.uploads;
  return `// The project's rules: generated from the IR's roles.

/** Each type's conditions by name, each filter compiled for that type's fields. */
const CONDITIONS: Record<string, Record<string, Condition>> = {
${enforcement.types.map(conditionsSource).join("\n")}
};

const ADMIN_ROLES: readonly string[] = ${list(admins)};

const RULES: Record<string, TypeRules> = {
${enforcement.types.map(typeRules).join("\n")}
};

/** The types and components that reach a type some role reads under a condition. */
const HOLDERS: Record<string, Holder> = {${holders === "" ? "" : `\n${holders}\n`}};
${uploads === null ? "" : uploadsSource(uploads)}
export const TABLES: Tables = { rules: RULES, holders: HOLDERS${uploads === null ? "" : ", uploads: UPLOADS"} };
`;
};

/** A type's controller: Strapi's core controller, with the enforced actions over it. */
export const enforcedControllerSource = (uid: string): string =>
  withMarker(`import { factories } from "@strapi/strapi";
import { TABLES } from "../../../permissions/api-conditions";
import { enforcedController } from "../../../permissions/api-controller";

// The IR's row conditions, assigned fields and every relation into a conditioned type, decided
// before Strapi's core actions run. The methods are type-checked by camis against the parts of
// Strapi they use; the cast keeps Strapi's own controller typings, which camis does not check
// them against, out of the build.
export default factories.createCoreController(${key(uid)}, ({ strapi }) =>
  enforcedController(strapi, ${key(uid)}, TABLES) as any,
);
`);

/**
 * The upload plugin's extension: a private attribute recording each file's uploader, and the
 * plugin's content API controller with the upload checks before it. A `strapi-server` hook, like
 * the users-permissions one, since it changes the loaded plugin rather than restating its schema.
 */
const uploadExtensionSource = (): string =>
  withMarker(`import { TABLES } from "../../permissions/api-conditions";
import { enforcedUpload } from "../../permissions/api-upload-controller";

// Strapi's content API passes no user to the upload service, so a file's createdBy (an admin
// user) stays empty for every users-permissions caller: camis records the uploader itself, in an
// attribute the content API neither returns nor lets a client filter on or set.
interface UploadPlugin {
  contentTypes: { file: { schema: { attributes: Record<string, unknown> } } };
  controllers: Record<string, unknown>;
}

export default (plugin: UploadPlugin): UploadPlugin => {
  plugin.contentTypes.file.schema.attributes.camisUploader = {
    type: "integer",
    private: true,
    configurable: false,
  };
  plugin.controllers["content-api"] = enforcedUpload(plugin.controllers["content-api"], TABLES);
  return plugin;
};
`);

/**
 * The decisions module (Ring 1 runtime, decisions, the project's rules), the controller methods,
 * the upload decisions they check a linked file with and, when a restricted role writes files,
 * the upload extension.
 */
export const emitApiEnforcementFiles = (enforcement: ApiEnforcement): GeneratedFile[] =>
  enforcement.types.length === 0 && enforcement.uploads === null
    ? []
    : [
        {
          path: API_CONDITIONS_PATH,
          content: withMarker(
            `${tsRuntimeSource()}\n${decisionsSource()}\n${rulesSource(enforcement)}`,
          ),
        },
        { path: API_CONTROLLER_PATH, content: withMarker(runtime("api-controller.ts")) },
        { path: API_UPLOADS_PATH, content: withMarker(runtime("api-uploads.ts")) },
        {
          path: API_UPLOAD_CONTROLLER_PATH,
          content: withMarker(runtime("api-upload-controller.ts")),
        },
        ...(enforcement.uploads === null
          ? []
          : [{ path: UPLOAD_EXTENSION_PATH, content: uploadExtensionSource() }]),
      ];
