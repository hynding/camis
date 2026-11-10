import { PHP_MARKER } from "../hooks/names";
import type { GraphqlSchema } from "./graphql-schema";
import { runtimePhp } from "../runtime-php";

const header = `<?php\n${PHP_MARKER}\n\ndeclare(strict_types=1);\n\nnamespace App\\GraphQL;\n`;

/** The schema's path, relative to the application, which the runtime reads and caches. */
export const GRAPHQL_SCHEMA_PATH = "graphql/schema.graphql";

const phpString = (value: string): string =>
  `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const phpBool = (value: boolean): string => (value ? "true" : "false");

/** The per-project half: which content type and action each root field is, and how types link. */
export const emitStrapiGraphqlTypes = (schema: GraphqlSchema, tokens: boolean): string => {
  const roots = (rows: [string, string, string][]) =>
    rows
      .map(([field, type, action]) => `        '${field}' => ['${type}', '${action}'],`)
      .join("\n");
  const nested = (entries: Record<string, { type: string; repeatable: boolean }>) =>
    Object.entries(entries)
      .map(
        ([k, v]) => `'${k}' => ['type' => '${v.type}', 'repeatable' => ${phpBool(v.repeatable)}]`,
      )
      .join(", ");
  const types = schema.types
    .map(
      (t) => `        '${t.name}' => [
            'controller' => ${t.name === "UploadFile" ? "null" : `\\App\\Http\\Controllers\\Api\\${t.model}ApiController::class`},
            'routeKey' => ${t.routeKey === null ? "null" : phpString(t.routeKey)},
            'draftPublish' => ${phpBool(t.draftPublish)},
            'localized' => ${phpBool(t.localized)},
            'relations' => [${Object.entries(t.relations)
              .map(
                ([k, r]) =>
                  `'${k}' => ['type' => '${r.type}', 'many' => ${phpBool(r.many)}, 'model' => \\App\\Models\\${r.model}::class]`,
              )
              .join(", ")}],
            'components' => [${nested(t.components)}],
            'zones' => [${t.zones.map(phpString).join(", ")}],
        ],`,
    )
    .join("\n");
  const components = schema.components
    .map(
      (c) =>
        `        '${c.name}' => ['uid' => ${phpString(c.uid)}, 'components' => [${nested(c.components)}]],`,
    )
    .join("\n");
  const plugins = schema.plugins
    .map(([field, action]) => `        '${field}' => '${action}',`)
    .join("\n");
  const roles = schema.roles
    .map(
      (r) =>
        `        ${phpString(r.type)} => ['name' => ${phpString(r.name)}, 'description' => ${r.description === null ? "null" : phpString(r.description)}],`,
    )
    .join("\n");
  const morphs = schema.types
    .filter((t) => t.name !== "UploadFile")
    .map((t) => `        ${phpString(t.uid)} => '${t.name}',`)
    .join("\n");
  const zones = Object.entries(schema.zoneMembers)
    .map(([union, members]) => `        '${union}' => [${members.map(phpString).join(", ")}],`)
    .join("\n");
  return `${header}
/** What graphql/schema.graphql's types are on the REST API (StrapiGraphql resolves through it). */
final class StrapiGraphqlTypes
{
    /** Query field → [content type, action]. */
    public const QUERIES = [
${roots(schema.queries)}
    ];

    /** Mutation field → [content type, action]. */
    public const MUTATIONS = [
${roots(schema.mutations)}
    ];

    /** Content type → its REST controller, and the keys that are relations, components and zones. */
    public const TYPES = [
${types}
    ];

    /** Component type → its uid and its own components. */
    public const COMPONENTS = [
${components}
    ];

    /** A dynamic zone's union → the component types it holds. */
    public const ZONES = [
${zones}
    ];

    /** A content type's uid → its type, for the GenericMorph entries a file is linked from. */
    public const MORPHS = [
${morphs}
    ];

    /** A plugin's root field → what StrapiGraphqlPlugins answers it with. */
    public const PLUGINS = [
${plugins}
    ];

    /** The IR's roles as users-permissions shows them, by type (the role's own name). */
    public const ROLES = [
${roles}
    ];

    /** Whether the project keeps API tokens, which StrapiGraphql checks each action against. */
    public const TOKENS = ${phpBool(tokens)};
}
`;
};

/**
 * Strapi 5's GraphQL content API (its graphql plugin) over the generated REST controllers: each
 * root field is the REST action it names, run with the caller's own credentials, so its grants,
 * row conditions, draft and publish, locales and validation are the REST API's own. The
 * selection set becomes the request's populate, so a list costs what the REST list costs; a
 * relation asked for twice with different arguments is fetched per row for the second ask.
 * `graphql-vectors.json`, recorded from strapi-php, is the check.
 *
 * Shared hosting: the printed schema is parsed once and kept in bootstrap/cache as a PHP array,
 * which opcache serves from then on; no process outlives a request.
 */
export const emitStrapiGraphql = (): string =>
  runtimePhp(new URL("./php/app/GraphQL/StrapiGraphql.php", import.meta.url));

/** POST and GET /graphql, beside /api rather than under it, as Strapi serves it. */
export const emitGraphqlRoutes = (secured: boolean): string => `<?php

// @camis:generated — do not edit. bootstrap/app.php loads this file (see camis scaffold).

declare(strict_types=1);

use App\\GraphQL\\StrapiGraphql;
use App\\Http\\Middleware\\StrapiActiveUser;
${secured ? "use App\\Http\\Middleware\\StrapiApiToken;\n" : ""}use App\\Http\\Middleware\\StrapiCredentials;
use App\\Http\\Middleware\\StrapiErrors;
use Illuminate\\Support\\Facades\\Route;

// The content API's own credentials: an API token, else a session, else the public role.
Route::middleware([StrapiErrors::class, ${secured ? "StrapiApiToken::class, " : ""}StrapiCredentials::class.':optional', StrapiActiveUser::class])
    ->match(['get', 'post'], '/graphql', StrapiGraphql::class);
`;
