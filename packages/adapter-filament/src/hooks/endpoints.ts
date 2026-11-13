import type { ApiStyle, GeneratedFile, StorageLayout } from "@camis/adapter-kernel";
import type { CapabilityGap, Endpoint, IrDocument } from "@camis/ir-schema";
import { PUBLIC_ROLE, type Role } from "@camis/permissions";
import { phpSingleQuoted } from "../php-literal";
import { PHP_MARKER } from "./names";

export const ENDPOINTS_CONTROLLER = "CamisEndpoints";

export interface EndpointsPlan {
  /** The endpoints the generated app routes. */
  served: Endpoint[];
  gaps: CapabilityGap[];
}

/** Only the Strapi API style on the laravel storage layout routes endpoints, beside Strapi's routes. */
export const endpointsPlan = (
  doc: IrDocument,
  apiStyle: ApiStyle,
  storage: StorageLayout,
): EndpointsPlan => {
  const endpoints = doc.endpoints ?? [];
  if (apiStyle === "strapi" && storage === "laravel") return { served: endpoints, gaps: [] };
  return {
    served: [],
    gaps: endpoints.map(
      (e): CapabilityGap => ({
        feature: "endpoint",
        location: { contentType: e.contentType, rule: e.name },
        severity: "downgrade",
        message: `endpoint "${e.name}" (${e.method} ${e.path}) is served only by apiStyle "strapi" on the laravel storage layout; its route is not generated`,
      }),
    ),
  };
};

/** The endpoint's route, under the API's prefix: Strapi's `:param` is Laravel's `{param}`. */
export const endpointRoute = (e: Endpoint): string =>
  `Route::${e.method.toLowerCase()}(${phpSingleQuoted(e.path.replace(/:([^/]+)/g, "{$1}"))}, ${ENDPOINTS_CONTROLLER}::class)->defaults('endpoint', ${phpSingleQuoted(e.name)})`;

const describe = (e: Endpoint): string => `${e.method} /api${e.path}`;

const contract = (e: Endpoint): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Hooks\\Contracts;

use Illuminate\\Http\\Request;

interface ${e.name}Endpoint
{
    /**
     * Answers ${describe(e)}; $request->route('<param>') holds each of the path's :params. An array
     * or JsonSerializable is sent as JSON, a Response as it is; a StrapiError answers with its status.
     */
    public function handle(Request $request): mixed;
}
`;

const stub = (e: Endpoint): string => `<?php

declare(strict_types=1);

namespace App\\Hooks;

use App\\Hooks\\Contracts\\${e.name}Endpoint;
use Illuminate\\Http\\Request;

// Ring 2 endpoint — hand-written. camis seeds this once and never overwrites it.
final class ${e.name} implements ${e.name}Endpoint
{
    public function handle(Request $request): mixed
    {
        // TODO: answer ${describe(e)}.
        return ['data' => null];
    }
}
`;

/** The roles that may call a non-public endpoint, by name; null when anyone may. */
const callers = (e: Endpoint, roles: Role[], secured: boolean): string[] | null =>
  !secured || e.public === true
    ? null
    : roles
        .filter((r) => (r.endpoints ?? []).includes(e.name))
        .map((r) => r.name)
        .sort();

const controller = (endpoints: Endpoint[], roles: Role[], secured: boolean): string => {
  const rows = [...endpoints]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const who = callers(e, roles, secured);
      return `        ${phpSingleQuoted(e.name)} => [\\App\\Hooks\\${e.name}::class, ${
        who === null ? "null" : `[${who.map(phpSingleQuoted).join(", ")}]`
      }],`;
    })
    .join("\n");
  const check = secured
    ? `
        if ($roles !== null && ! StrapiApiTokens::active() && ! self::holds($request->user(), $roles)) {
            throw new StrapiError(403, 'ForbiddenError', 'Forbidden');
        }
`
    : "";
  const holds = secured
    ? `

    /**
     * Whether the caller's role lists the endpoint: a caller without a session holds the public role.
     *
     * @param list<string> $roles
     */
    private static function holds(mixed $user, array $roles): bool
    {
        return $user instanceof User ? $user->hasAnyRole($roles) : in_array('${PUBLIC_ROLE}', $roles, true);
    }`
    : "";
  return `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Controllers\\Api;

use App\\Http\\Controllers\\Controller;${secured ? "\nuse App\\Models\\User;\nuse App\\Support\\StrapiApiTokens;\nuse App\\Support\\StrapiError;" : ""}
use Illuminate\\Http\\Request;

/**
 * Strapi's custom routes: each IR endpoint's route reaches its hand-written handler in app/Hooks,
 * once the caller's role lists the endpoint (null: anyone may call it). An API token is checked
 * where Strapi checks it, before the route: a full-access token calls every endpoint.
 */
final class ${ENDPOINTS_CONTROLLER} extends Controller
{
    /** @var array<string, array{class-string, list<string>|null}> */
    private const ENDPOINTS = [
${rows}
    ];

    public function __invoke(Request $request): mixed
    {
        [$handler${secured ? ", $roles" : ""}] = self::ENDPOINTS[(string) $request->route('endpoint')];${check}
        return app($handler)->handle($request);
    }${holds}
}
`;
};

/** Each endpoint's contract and seeded handler, and the controller its route reaches. */
export const emitEndpointFiles = (
  endpoints: Endpoint[],
  roles: Role[],
  secured: boolean,
): GeneratedFile[] =>
  endpoints.length === 0
    ? []
    : [
        ...endpoints.flatMap((e): GeneratedFile[] => [
          { path: `app/Hooks/Contracts/${e.name}Endpoint.php`, content: contract(e) },
          { path: `app/Hooks/${e.name}.php`, content: stub(e), mode: "seed" },
        ]),
        {
          path: `app/Http/Controllers/Api/${ENDPOINTS_CONTROLLER}.php`,
          content: controller(endpoints, roles, secured),
        },
      ];
