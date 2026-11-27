import type { Endpoint } from "@camis/ir-schema";

/**
 * The variable a deployment sets to change an endpoint's throttle without regenerating:
 * `CAMIS_ENDPOINT_<NAME>_THROTTLE_PER_MINUTE`, the name in upper snake case, as
 * `CAMIS_AUTH_THROTTLE_PER_MINUTE` is the credential routes'. Every target reads the same one.
 */
export const endpointThrottleEnv = (name: string): string =>
  `CAMIS_ENDPOINT_${name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toUpperCase()}_THROTTLE_PER_MINUTE`;

const GUARDS = ["throttle", "maxBodyBytes", "accepts", "crossOrigin"] as const;

/** The guards the endpoint declares, by their IR names, in the order its route checks them. */
export const endpointGuardNames = (e: Endpoint): string[] =>
  GUARDS.filter((guard) => e[guard] !== undefined);

/** Whether the endpoint declares a guard its route checks before the handler runs. */
export const isGuardedEndpoint = (e: Endpoint): boolean => endpointGuardNames(e).length > 0;

/**
 * Text as code in a Markdown table cell: a pipe would end the cell, so it is escaped (GitHub's
 * tables read `\|` as a pipe even in code), and a backtick takes a code span of two.
 */
const tableCode = (text: string): string => {
  const escaped = text.replace(/\|/g, "\\|");
  return text.includes("`") ? `\`\` ${escaped} \`\`` : `\`${escaped}\``;
};

const cell = (items: readonly string[] | undefined): string =>
  items === undefined ? "" : items.map(tableCode).join(", ");

const guardRow =
  (prefix: string) =>
  (e: Endpoint): string =>
    `| \`${e.name}\` | \`${e.method} ${prefix}${e.path}\` | ${
      e.throttle === undefined ? "" : `${e.throttle.perMinute} (\`${endpointThrottleEnv(e.name)}\`)`
    } | ${e.maxBodyBytes ?? ""} | ${cell(e.accepts?.map((t) => t.toLowerCase()))} | ${
      e.crossOrigin?.headers.length === 0 ? "none" : cell(e.crossOrigin?.headers)
    } |`;

/**
 * The guarded endpoints' declared guards as a Markdown table, for a target's DEPLOY.md, each route
 * under the prefix the target serves its API at.
 */
export const endpointGuardsTable = (guarded: Endpoint[], prefix: string): string =>
  [
    "| Endpoint | Route | Requests a minute per address | Largest body (bytes) | Media types | Cross-origin request headers |",
    "| --- | --- | --- | --- | --- | --- |",
    ...guarded.map(guardRow(prefix)),
  ].join("\n");
