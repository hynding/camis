import { z } from "zod";
import { fieldName, typeName } from "./identifiers";

export const HOOK_SCALARS = ["string", "text", "integer", "float", "boolean", "dateTime"] as const;
export type HookScalar = (typeof HOOK_SCALARS)[number];

export const shapeField = z.object({ name: fieldName, type: z.enum(HOOK_SCALARS) });
export type ShapeField = z.infer<typeof shapeField>;

/** A record's lifecycle events, each of which can run a hook. */
export const LIFECYCLE_TRIGGERS = [
  "beforeCreate",
  "afterCreate",
  "beforeUpdate",
  "afterUpdate",
  "beforeDelete",
  "afterDelete",
] as const;
export const HOOK_TRIGGERS = ["onPublish", ...LIFECYCLE_TRIGGERS] as const;
export type HookTrigger = (typeof HOOK_TRIGGERS)[number];

/** Triggers that run before the record is written, so a hook's output can still change it. */
export const WRITING_TRIGGERS: readonly HookTrigger[] = [
  "onPublish",
  "beforeCreate",
  "beforeUpdate",
];

export const hook = z
  .object({
    name: typeName,
    trigger: z.enum(HOOK_TRIGGERS),
    contentType: typeName,
    input: z.array(shapeField).min(1),
    output: z.array(shapeField),
  })
  .superRefine((h, ctx) => {
    if (h.output.length > 0 && !WRITING_TRIGGERS.includes(h.trigger)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a ${h.trigger} hook cannot change the record, so its output must be empty`,
        params: { irCode: "hook_output_not_written" },
        path: ["output"],
      });
    }
  });
export type Hook = z.infer<typeof hook>;

/** The content API's actions on a content type, which a route policy or middleware can guard. */
export const ROUTE_ACTIONS = ["list", "read", "create", "update", "delete"] as const;
export type RouteAction = (typeof ROUTE_ACTIONS)[number];

/**
 * Hand-written code on a content type's API routes: a policy decides whether a request goes on,
 * a middleware wraps it. With no actions it is on every one.
 */
export const routeHook = z.object({
  name: typeName,
  contentType: typeName,
  actions: z.array(z.enum(ROUTE_ACTIONS)).min(1).optional(),
});
export type RouteHook = z.infer<typeof routeHook>;

export const ENDPOINT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type EndpointMethod = (typeof ENDPOINT_METHODS)[number];

/**
 * Hand-written code behind an API route of its own, beside a content type's (Strapi's custom route
 * and controller action). Only the public endpoints and those a role lists are reached.
 */
export const endpoint = z.object({
  name: typeName,
  /** The content type it belongs beside, as a Strapi custom route belongs to an API. */
  contentType: typeName,
  method: z.enum(ENDPOINT_METHODS),
  /** Under the API's prefix, Strapi's form: `/articles/:id/like`. */
  path: z
    .string()
    .regex(/^(?:\/:?[A-Za-z0-9_-]+)+$/, "a path is /segments, each a name or a :param"),
  /** Open to anyone: no caller is authenticated and no role is asked (Strapi's auth: false). */
  public: z.boolean().optional(),
});
export type Endpoint = z.infer<typeof endpoint>;

// Five fields (minute hour day-of-month month day-of-week); every target's scheduler reads these.
const CRON_FIELD = "[0-9A-Za-z*/,?-]+";
const CRON = new RegExp(`^${CRON_FIELD}( ${CRON_FIELD}){4}$`);

/** Hand-written code the target runs on a cron schedule. */
export const schedule = z.object({
  name: typeName,
  cron: z.string().regex(CRON, "a cron expression has five fields: minute hour day month weekday"),
});
export type Schedule = z.infer<typeof schedule>;
