import type { GeneratedFile } from "@camis/adapter-kernel";
import type { ContentType, IrDocument, RouteAction, RouteHook } from "@camis/ir-schema";
import { ROUTE_ACTIONS } from "@camis/ir-schema";
import { filamentNames } from "../names";
import { PHP_MARKER } from "./names";

export const ROUTE_HOOKS_MIDDLEWARE = "CamisRouteHooks";

const actionsOf = (r: RouteHook): readonly RouteAction[] => r.actions ?? ROUTE_ACTIONS;

const describeActions = (r: RouteHook, ct: ContentType): string =>
  `${ct.name}: ${r.actions === undefined ? "every action" : r.actions.join(", ")}`;

const policyContract = (r: RouteHook): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Hooks\\Contracts;

use Illuminate\\Http\\Request;

interface ${r.name}Policy
{
    /**
     * Whether the request may go on to the ${r.contentType} route's action (list, read, create, update or
     * delete). False answers 403 "Policy Failed"; throwing answers with what is thrown.
     */
    public function allows(Request $request, string $action): bool;
}
`;

const policyStub = (r: RouteHook, ct: ContentType): string => `<?php

declare(strict_types=1);

namespace App\\Hooks;

use App\\Hooks\\Contracts\\${r.name}Policy;
use Illuminate\\Http\\Request;

// Ring 2 policy — hand-written. camis seeds this once and never overwrites it.
final class ${r.name} implements ${r.name}Policy
{
    public function allows(Request $request, string $action): bool
    {
        // TODO: decide whether the request may go on (${describeActions(r, ct)}).
        return true;
    }
}
`;

const middlewareContract = (r: RouteHook): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Hooks\\Contracts;

use Closure;
use Illuminate\\Http\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

interface ${r.name}Middleware
{
    /**
     * Wraps the ${r.contentType} route's action, after its policies: call $next($request) to go on.
     *
     * @param Closure(Request): Response $next
     */
    public function handle(Request $request, Closure $next): Response;
}
`;

const middlewareStub = (r: RouteHook, ct: ContentType): string => `<?php

declare(strict_types=1);

namespace App\\Hooks;

use App\\Hooks\\Contracts\\${r.name}Middleware;
use Closure;
use Illuminate\\Http\\Request;
use Symfony\\Component\\HttpFoundation\\Response;

// Ring 2 middleware — hand-written. camis seeds this once and never overwrites it.
final class ${r.name} implements ${r.name}Middleware
{
    public function handle(Request $request, Closure $next): Response
    {
        // TODO: wrap the request (${describeActions(r, ct)}).
        return $next($request);
    }
}
`;

const hookMap = (hooks: RouteHook[]): string =>
  hooks.length === 0
    ? "[]"
    : `[
${hooks
  .map(
    (r) =>
      `                \\App\\Hooks\\${r.name}::class => [${actionsOf(r)
        .map((a) => `'${a}'`)
        .join(", ")}],`,
  )
  .join("\n")}
            ]`;

const runtime = (
  routes: { ct: ContentType; policies: RouteHook[]; middlewares: RouteHook[] }[],
  strapi: boolean,
): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

namespace App\\Http\\Middleware;
${strapi ? "\nuse App\\Support\\StrapiError;" : ""}
use Closure;
use Illuminate\\Http\\Request;
use Illuminate\\Pipeline\\Pipeline;
use Symfony\\Component\\HttpFoundation\\Response;

/**
 * Runs the policies, then the middlewares, the IR puts on a content API route, as Strapi runs a
 * route's config.policies and then its config.middlewares. Each is a hand-written class in app/Hooks.
 */
final class ${ROUTE_HOOKS_MIDDLEWARE}
{
    /** The content API action each controller method serves. */
    private const ACTIONS = [
        'index' => 'list',
        'show' => 'read',
        'single' => 'read',
        'store' => 'create',
        'update' => 'update',
        'putSingle' => 'update',
        'destroy' => 'delete',
        'destroySingle' => 'delete',
    ];

    /** @var array<class-string, array{policies: array<class-string, list<string>>, middlewares: array<class-string, list<string>>}> */
    private const ROUTES = [
${routes
  .map(
    ({ ct, policies, middlewares }) =>
      `        \\App\\Http\\Controllers\\Api\\${filamentNames(ct).model}ApiController::class => [
            'policies' => ${hookMap(policies)},
            'middlewares' => ${hookMap(middlewares)},
        ],`,
  )
  .join("\n")}
    ];

    public function handle(Request $request, Closure $next): Response
    {
        $route = $request->route();
        $hooks = self::ROUTES[$route->getControllerClass()] ?? null;
        $action = self::ACTIONS[$route->getActionMethod()] ?? null;
        if ($hooks === null || $action === null) {
            return $next($request);
        }
        foreach ($hooks['policies'] as $policy => $actions) {
            if (in_array($action, $actions, true) && ! app($policy)->allows($request, $action)) {
                ${strapi ? "throw new StrapiError(403, 'PolicyError', 'Policy Failed');" : "abort(403, 'Policy Failed');"}
            }
        }
        $middlewares = array_keys(array_filter(
            $hooks['middlewares'],
            fn (array $actions): bool => in_array($action, $actions, true),
        ));

        return (new Pipeline(app()))->send($request)->through($middlewares)->then($next);
    }
}
`;

export interface RouteHookEmission {
  files: GeneratedFile[];
  /** Content types whose API routes run the route hooks middleware. */
  hooked: Set<string>;
}

/** The IR's route policies and middlewares: a seam each, and the middleware that runs them. */
export const emitRouteHookFiles = (doc: IrDocument, strapi: boolean): RouteHookEmission => {
  const policies = doc.policies ?? [];
  const middlewares = doc.middlewares ?? [];
  const routes = doc.contentTypes
    .map((ct) => ({
      ct,
      policies: policies.filter((r) => r.contentType === ct.name),
      middlewares: middlewares.filter((r) => r.contentType === ct.name),
    }))
    .filter((r) => r.policies.length + r.middlewares.length > 0);
  const files: GeneratedFile[] = [];
  for (const { ct, policies: own, middlewares: wraps } of routes) {
    for (const r of own) {
      files.push({ path: `app/Hooks/Contracts/${r.name}Policy.php`, content: policyContract(r) });
      files.push({ path: `app/Hooks/${r.name}.php`, content: policyStub(r, ct), mode: "seed" });
    }
    for (const r of wraps) {
      files.push({
        path: `app/Hooks/Contracts/${r.name}Middleware.php`,
        content: middlewareContract(r),
      });
      files.push({ path: `app/Hooks/${r.name}.php`, content: middlewareStub(r, ct), mode: "seed" });
    }
  }
  if (routes.length > 0) {
    files.push({
      path: `app/Http/Middleware/${ROUTE_HOOKS_MIDDLEWARE}.php`,
      content: runtime(routes, strapi),
    });
  }
  return { files, hooked: new Set(routes.map((r) => r.ct.name)) };
};
