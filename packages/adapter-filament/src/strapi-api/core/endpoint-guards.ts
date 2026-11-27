import { endpointThrottleEnv, isGuardedEndpoint, type GeneratedFile } from "@camis/adapter-kernel";
import type { Endpoint } from "@camis/ir-schema";
import { PHP_MARKER } from "../../hooks/names";
import { phpSingleQuoted } from "../../php-literal";
import { runtimePhp } from "../../runtime-php";

export const ENDPOINT_GUARDS_CONFIG_PATH = "config/camis-endpoints.php";
const GUARD_PATH = "app/Http/Middleware/StrapiEndpointGuard.php";
const CORS_PATH = "app/Http/Middleware/StrapiEndpointCors.php";
export const ENDPOINT_GUARD = "StrapiEndpointGuard";
export const ENDPOINT_CORS = "StrapiEndpointCors";

/** Whether the endpoint has a guard StrapiEndpointGuard checks (all but crossOrigin). */
const checked = (e: Endpoint): boolean =>
  e.throttle !== undefined || e.maxBodyBytes !== undefined || e.accepts !== undefined;

/** The route middlewares an endpoint's guards need, outermost first. */
export const endpointMiddlewares = (e: Endpoint): string[] => [
  ...(e.crossOrigin !== undefined ? [ENDPOINT_CORS] : []),
  ...(checked(e) ? [ENDPOINT_GUARD] : []),
];

const middlewareCall = (classes: string[]): string =>
  classes.length === 0
    ? ""
    : classes.length === 1
      ? `->middleware(${classes[0]!}::class)`
      : `->middleware([${classes.map((c) => `${c}::class`).join(", ")}])`;

/** What follows an endpoint's route to run its guards; nothing for an endpoint with none. */
export const endpointGuardsCall = (e: Endpoint): string => middlewareCall(endpointMiddlewares(e));

/** What follows the endpoint's preflight route, which StrapiEndpointCors answers alone. */
export const preflightCall = (): string => middlewareCall([ENDPOINT_CORS]);

/** Media types compare in lower case, as a request's Content-Type is folded before comparing. */
const mediaTypes = (e: Endpoint): string[] => (e.accepts ?? []).map((t) => t.toLowerCase());

const phpList = (items: string[]): string => `[${items.map(phpSingleQuoted).join(", ")}]`;

const configEntry = (e: Endpoint): string => {
  const keys = [
    `'method' => ${phpSingleQuoted(e.method)}`,
    ...(e.throttle === undefined
      ? []
      : [
          `'throttle_per_minute' => max(1, (int) env(${phpSingleQuoted(endpointThrottleEnv(e.name))}, ${e.throttle.perMinute}))`,
        ]),
    ...(e.maxBodyBytes === undefined ? [] : [`'max_body_bytes' => ${e.maxBodyBytes}`]),
    ...(e.accepts === undefined ? [] : [`'accepts' => ${phpList(mediaTypes(e))}`]),
    ...(e.crossOrigin === undefined
      ? []
      : [`'cross_origin_headers' => ${phpList(e.crossOrigin.headers)}`]),
  ];
  return `    ${phpSingleQuoted(e.name)} => [\n${keys.map((k) => `        ${k},`).join("\n")}\n    ],`;
};

const config = (guarded: Endpoint[]): string => `<?php
${PHP_MARKER}

declare(strict_types=1);

/*
 * Each guarded IR endpoint's guards, by endpoint name, read per request on its route by
 * StrapiEndpointGuard (throttle, media types, body size) and StrapiEndpointCors (answers to browsers
 * on any origin). A throttle counts per client address, refused requests included; its rate is
 * deployment-specific, so a variable of its own overrides it, floored at 1, since (int) reads an
 * empty or non-numeric value as 0.
 */
return [
${guarded.map(configEntry).join("\n")}
];
`;

/** The guarded endpoints' config and the runtime middlewares their routes name; none without. */
export const emitEndpointGuardFiles = (endpoints: Endpoint[]): GeneratedFile[] => {
  const guarded = endpoints.filter(isGuardedEndpoint).sort((a, b) => a.name.localeCompare(b.name));
  if (guarded.length === 0) return [];
  const runtime = (path: string): GeneratedFile => ({
    path,
    content: runtimePhp(new URL(`./php/${path}`, import.meta.url)),
  });
  return [
    { path: ENDPOINT_GUARDS_CONFIG_PATH, content: config(guarded) },
    ...(guarded.some(checked) ? [runtime(GUARD_PATH)] : []),
    ...(guarded.some((e) => e.crossOrigin !== undefined) ? [runtime(CORS_PATH)] : []),
  ];
};

const either = (items: string[]): string =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)!}`;

/** The contract's account of what the route checked before the handler runs; none unguarded. */
export const endpointGuardsDoc = (e: Endpoint): string[] => {
  if (!isGuardedEndpoint(e)) return [];
  const checks = [
    ...(e.throttle === undefined
      ? []
      : [
          `- the throttle: ${e.throttle.perMinute} requests a minute per client address (${endpointThrottleEnv(e.name)}), else 429;`,
        ]),
    ...(e.accepts === undefined
      ? []
      : [`- the body's media type: ${either(mediaTypes(e))}, else 415;`]),
    ...(e.maxBodyBytes === undefined
      ? []
      : [`- the body's size: at most ${e.maxBodyBytes} bytes, declared or sent, else 413;`]),
  ];
  const last = checks.length - 1;
  const listed = checks.map((line, i) => (i === last ? line.replace(/;$/, ".") : line));
  const cors =
    e.crossOrigin === undefined
      ? []
      : e.crossOrigin.headers.length === 0
        ? [
            "Browsers on any origin call it without credentials; its preflight allows no request",
            "header beyond those always allowed.",
          ]
        : [
            "Browsers on any origin call it without credentials; its preflight allows the request headers",
            `${e.crossOrigin.headers.join(", ")}.`,
          ];
  return [
    "",
    ...(checks.length === 0
      ? []
      : ["Its route has already checked, in this order (config/camis-endpoints.php):", ...listed]),
    ...cors,
  ];
};
