import {
  assignedValues,
  callerOf,
  createVerdict,
  listFilter,
  recordQuery,
  recordVerdict,
  scopedFilters,
  withoutAssigned,
  type RecordAction,
  type TypeRules,
} from "./api-conditions";

// The core controller methods a content type with row conditions or assigned fields is served
// by, copied into each generated Strapi project as src/permissions/api-controller.ts. A type's
// generated controller passes them to factories.createCoreController, which puts Strapi's own
// core controller under them as their prototype: `super` is that core controller.

interface RequestContext {
  params?: { id?: unknown };
  state?: unknown;
  request?: { body?: unknown };
  status?: number;
  notFound: () => unknown;
  forbidden: () => unknown;
}

/** The parts of Strapi's core controller these methods build on. */
interface CoreController {
  validateQuery(ctx: RequestContext): Promise<void>;
  sanitizeQuery(ctx: RequestContext): Promise<Record<string, unknown>>;
  validateInput?(data: unknown, ctx: RequestContext): Promise<void>;
  sanitizeInput(data: unknown, ctx: RequestContext): Promise<Record<string, unknown>>;
  sanitizeOutput(data: unknown, ctx: RequestContext): Promise<unknown>;
  transformResponse(data: unknown, meta?: unknown): unknown;
}

/** The parts of Strapi itself they use: the type's service and the query engine. */
interface StrapiServices {
  db: { query(uid: string): { findMany(params: object): Promise<unknown[]> } };
  service(uid: string): {
    find(params: object): Promise<{ results: unknown; pagination: unknown }>;
    create(params: object): Promise<unknown>;
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The type's find, findOne, create, update and delete, each deciding on the caller's role before
 * Strapi's own: a list narrowed in the query (so paging and counts hold only what the caller may
 * read), an entry checked before it is read, changed or deleted, and assigned fields filled from
 * the session on create and left out of an update.
 */
export const enforcedController = (strapiInstance: unknown, uid: string, rules: TypeRules) => {
  const strapi = strapiInstance as StrapiServices;

  const verdict = async (ctx: RequestContext, action: string, as: RecordAction) => {
    const caller = callerOf(rules, ctx.state, action);
    if (caller.kind === "unrestricted") return "allow";
    if (caller.kind === "refused") return "forbidden";
    const rows = await strapi.db
      .query(uid)
      .findMany(recordQuery(rules, String(ctx.params?.id ?? "")));
    return recordVerdict(rules, caller, as, rows);
  };

  /** The body with the caller's assigned fields left out, or unchanged when it has no data. */
  const stripBody = (ctx: RequestContext, action: string): void => {
    const body = ctx.request?.body;
    if (ctx.request === undefined || !isObject(body) || !isObject(body.data)) return;
    ctx.request.body = {
      ...body,
      data: withoutAssigned(callerOf(rules, ctx.state, action), body.data),
    };
  };

  return {
    async find(this: CoreController, ctx: RequestContext) {
      const scope = listFilter(rules, callerOf(rules, ctx.state, "find"));
      if (scope === null) return super.find(ctx);
      await this.validateQuery(ctx);
      const query = await this.sanitizeQuery(ctx);
      const { results, pagination } = await strapi
        .service(uid)
        .find({ ...query, filters: scopedFilters(query.filters, scope) });
      const sanitized = await this.sanitizeOutput(results, ctx);
      return this.transformResponse(sanitized, { pagination });
    },

    async findOne(ctx: RequestContext) {
      const answer = await verdict(ctx, "findOne", "read");
      if (answer === "notFound") return ctx.notFound();
      if (answer === "forbidden") return ctx.forbidden();
      return super.findOne(ctx);
    },

    async create(this: CoreController, ctx: RequestContext) {
      const caller = callerOf(rules, ctx.state, "create");
      if (caller.kind === "refused") return ctx.forbidden();
      const body = ctx.request?.body;
      // Strapi's own create answers a missing payload.
      if (ctx.request === undefined || !isObject(body) || !isObject(body.data))
        return super.create(ctx);
      const data = withoutAssigned(caller, body.data);
      if (createVerdict(rules, caller, data) === "forbidden") return ctx.forbidden();
      ctx.request.body = { ...body, data };
      const assigned = assignedValues(caller);
      if (Object.keys(assigned).length === 0) return super.create(ctx);
      // The assigned relation is added after validation: the role need not read the user type,
      // which Strapi's validator would demand of a relation the client wrote.
      await this.validateQuery(ctx);
      const query = await this.sanitizeQuery(ctx);
      if (this.validateInput !== undefined) await this.validateInput(data, ctx);
      const input = await this.sanitizeInput(data, ctx);
      const entity = await strapi
        .service(uid)
        .create({ ...query, data: { ...input, ...assigned } });
      const sanitized = await this.sanitizeOutput(entity, ctx);
      ctx.status = 201;
      return this.transformResponse(sanitized);
    },

    async update(ctx: RequestContext) {
      const answer = await verdict(ctx, "update", "update");
      if (answer === "notFound") return ctx.notFound();
      if (answer === "forbidden") return ctx.forbidden();
      stripBody(ctx, "update");
      return super.update(ctx);
    },

    async delete(ctx: RequestContext) {
      const answer = await verdict(ctx, "delete", "delete");
      if (answer === "notFound") return ctx.notFound();
      if (answer === "forbidden") return ctx.forbidden();
      return super.delete(ctx);
    },
  };
};
