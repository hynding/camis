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

// RFC 9110's token: what an HTTP header name is made of.
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// A media type without parameters: type/subtype, each a token.
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const headerName = z.string().refine((name) => HTTP_TOKEN.test(name), {
  message: "a request header name is an HTTP token: letters, digits and !#$%&'*+.^_`|~-",
  params: { irCode: "invalid_header_name" },
});

// A wildcard (*/*, text/*) is an Accept header's range: no body is of that type.
const mediaType = z.string().refine((type) => MEDIA_TYPE.test(type) && !type.includes("*"), {
  message:
    "a media type is type/subtype, without parameters or a wildcard (application/json, text/plain)",
  params: { irCode: "invalid_media_type" },
});

// Targets write the number as a literal, and past 2^31 - 1 some would write it in exponent form.
const LARGEST = 2_147_483_647;
const atLeastOne = z.number().int().min(1).max(LARGEST);

/**
 * Hand-written code behind an API route of its own, beside a content type's (Strapi's custom route
 * and controller action). Only the public endpoints and those a role lists are reached. Its guards
 * are declared, so the route refuses what they refuse before the handler runs.
 */
export const endpoint = z
  .object({
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
    /** At most this many requests a minute per caller address, refused ones included; then 429. */
    throttle: z.object({ perMinute: atLeastOne }).optional(),
    /** A body of more bytes, declared or sent, is refused with 413 before it is read as a value. */
    maxBodyBytes: atLeastOne.optional(),
    /** The media types its body may have, compared without parameters; another is refused with 415. */
    accepts: z.array(mediaType).min(1).optional(),
    /**
     * Answers browsers from any origin, without credentials: a preflight allows its method and
     * exactly these request headers. Only a public endpoint, which no credential reaches.
     */
    crossOrigin: z.object({ headers: z.array(headerName) }).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.crossOrigin !== undefined && e.public !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `endpoint "${e.name}" answers browsers from any origin (crossOrigin), so it must be public`,
        params: { irCode: "cross_origin_not_public" },
        path: ["crossOrigin"],
      });
    }
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
