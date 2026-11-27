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
