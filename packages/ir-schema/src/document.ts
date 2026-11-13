import { z } from "zod";
import { componentField, field, fieldApiName } from "./fields";
import { endpoint, hook, ROUTE_ACTIONS, routeHook, schedule, type RouteAction } from "./hooks";
import { collectionName, fieldName, typeName } from "./identifiers";

const RESERVED_FIELD_NAMES = new Set(["id"]);

type RefinedField = {
  name: string;
  type: string;
  targetField?: string;
  names?: { api?: string | undefined } | undefined;
};

const SINGULAR: Record<string, string> = {
  hooks: "hook",
  policies: "policy",
  middlewares: "middleware",
  endpoints: "endpoint",
};

/** A single type is one entry: there is no list of them, and nothing to create beside it. */
const singleLacks = (action: RouteAction): boolean => action === "list" || action === "create";

const nodeRefine = (fields: RefinedField[], ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  const keys = new Set<string>();
  fields.forEach((f, i) => {
    if (seen.has(f.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate field name "${f.name}"`,
        params: { irCode: "duplicate_field" },
        path: ["fields", i, "name"],
      });
    }
    seen.add(f.name);
    // A field's API key must be as unique as its name, or one would shadow the other on the wire.
    const key = fieldApiName(f);
    if (key !== f.name && (keys.has(key) || fields.some((g) => g !== f && g.name === key))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `field "${f.name}" goes by "${key}" on the API, which another field also does`,
        params: { irCode: "duplicate_field" },
        path: ["fields", i, "names", "api"],
      });
    }
    keys.add(key);
    if (RESERVED_FIELD_NAMES.has(key) && key !== f.name) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${key}" is a reserved field name`,
        params: { irCode: "reserved_field_name" },
        path: ["fields", i, "names", "api"],
      });
    }
    if (RESERVED_FIELD_NAMES.has(f.name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${f.name}" is a reserved field name`,
        params: { irCode: "reserved_field_name" },
        path: ["fields", i, "name"],
      });
    }
  });
  fields.forEach((f, i) => {
    if (
      f.type === "uid" &&
      f.targetField !== undefined &&
      !fields.some((s) => s.name === f.targetField)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `uid targetField "${f.targetField}" does not exist`,
        params: { irCode: "unknown_uid_target" },
        path: ["fields", i, "targetField"],
      });
    }
  });
};

export const contentType = z
  .object({
    name: typeName,
    kind: z.enum(["collection", "single"]),
    /** A type the target supplies: the users it authenticates, or the media library's files. */
    builtin: z.enum(["user", "file"]).optional(),
    names: z
      .object({
        plural: z.string().optional(),
        display: z.string().optional(),
        collection: collectionName.optional(),
      })
      .optional(),
    fields: z.array(field),
    options: z
      .object({
        draftPublish: z.boolean().optional(),
        timestamps: z.boolean().optional(),
        softDelete: z.boolean().optional(),
        upsertBy: fieldName.optional(),
        /** Each document keeps one version per locale. */
        localized: z.boolean().optional(),
        /** The content API actions the type serves; absent, it serves every one. */
        apiActions: z.array(z.enum(ROUTE_ACTIONS)).optional(),
        /**
         * The served actions open to anyone: no caller is authenticated and no grant is asked,
         * though the type's route policies and middlewares still run.
         */
        publicApiActions: z.array(z.enum(ROUTE_ACTIONS)).optional(),
      })
      .optional(),
  })
  .superRefine((ct, ctx) => {
    nodeRefine(ct.fields as RefinedField[], ctx);
    if (ct.kind === "single") {
      // A single type is one entry: there is no list of them, and nothing to create beside it.
      (ct.options?.apiActions ?? []).forEach((action, i) => {
        if (!singleLacks(action)) return;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `single type "${ct.name}" serves one entry, so it has no "${action}" action`,
          params: { irCode: "single_type_action" },
          path: ["options", "apiActions", i],
        });
      });
    }
    (ct.options?.publicApiActions ?? []).forEach((action, i) => {
      if (servesApiAction(ct, action) && !(ct.kind === "single" && singleLacks(action))) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `content type "${ct.name}" opens "${action}" to the public, but does not serve it`,
        params: { irCode: "public_action_not_served" },
        path: ["options", "publicApiActions", i],
      });
    });
    if (ct.options?.localized === true) return;
    ct.fields.forEach((f, i) => {
      if ("localized" in f && f.localized !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `field "${f.name}" sets localized, but content type "${ct.name}" is not localized`,
          params: { irCode: "localized_field_without_localized_type" },
          path: ["fields", i, "localized"],
        });
      }
    });
  });

export const component = z
  .object({
    name: typeName,
    names: z
      .object({
        collection: collectionName.optional(),
        group: collectionName.optional(),
      })
      .optional(),
    fields: z.array(componentField),
  })
  .superRefine((c, ctx) => nodeRefine(c.fields as RefinedField[], ctx));

export const irDocument = z
  .object({
    version: z.literal(1),
    contentTypes: z.array(contentType),
    components: z.array(component),
    hooks: z.array(hook).optional(),
    policies: z.array(routeHook).optional(),
    middlewares: z.array(routeHook).optional(),
    schedules: z.array(schedule).optional(),
    endpoints: z.array(endpoint).optional(),
  })
  .superRefine((doc, ctx) => {
    const byName = new Map(doc.contentTypes.map((ct) => [ct.name, ct]));
    const unknownType = (list: string, i: number, name: string, contentType: string): void => {
      if (byName.has(contentType)) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${SINGULAR[list]} "${name}" references unknown content type "${contentType}"`,
        params: { irCode: "unknown_hook_content_type" },
        path: [list, i, "contentType"],
      });
    };
    // Each becomes a class of its own name in the target, so the names share one namespace.
    const seen = new Set<string>();
    const unique = (list: string, i: number, name: string): void => {
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate hook name "${name}"`,
          params: { irCode: "duplicate_hook" },
          path: [list, i, "name"],
        });
      }
      seen.add(name);
    };
    (doc.hooks ?? []).forEach((h, i) => {
      unknownType("hooks", i, h.name, h.contentType);
      unique("hooks", i, h.name);
      const fields = new Set(byName.get(h.contentType)?.fields.map((f) => f.name) ?? []);
      if (!byName.has(h.contentType)) return;
      (["input", "output"] as const).forEach((shape) =>
        h[shape].forEach((f, j) => {
          if (fields.has(f.name)) return;
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `hook "${h.name}" ${shape} names "${f.name}", which "${h.contentType}" has no field of`,
            params: { irCode: "unknown_hook_field" },
            path: ["hooks", i, shape, j, "name"],
          });
        }),
      );
    });
    for (const list of ["policies", "middlewares"] as const) {
      (doc[list] ?? []).forEach((r, i) => {
        unknownType(list, i, r.name, r.contentType);
        unique(list, i, r.name);
      });
    }
    (doc.schedules ?? []).forEach((s, i) => unique("schedules", i, s.name));
    // A route answers one endpoint: a parameter's name does not tell two routes apart.
    const routes = new Set<string>();
    (doc.endpoints ?? []).forEach((e, i) => {
      unknownType("endpoints", i, e.name, e.contentType);
      unique("endpoints", i, e.name);
      const route = `${e.method} ${e.path.replace(/:[^/]+/g, ":")}`;
      if (routes.has(route))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `endpoint "${e.name}" answers ${e.method} ${e.path}, which another endpoint answers`,
          params: { irCode: "duplicate_endpoint_route" },
          path: ["endpoints", i, "path"],
        });
      routes.add(route);
    });
  });

export type ContentType = z.infer<typeof contentType>;
export type Component = z.infer<typeof component>;
export type IrDocument = z.infer<typeof irDocument>;

/** Whether the type serves the action to anyone, unauthenticated and with no grant asked. */
export const isPublicApiAction = (ct: ContentType, action: RouteAction): boolean =>
  (ct.options?.publicApiActions ?? []).includes(action);

/** Whether the type's content API serves the action (a type lists none: it serves every one). */
export const servesApiAction = (ct: ContentType, action: RouteAction): boolean =>
  (ct.options?.apiActions ?? ROUTE_ACTIONS).includes(action);
