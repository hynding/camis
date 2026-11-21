import {
  assignedValues,
  callerOf,
  createVerdict,
  listFilter,
  recordQuery,
  recordVerdict,
  refsQuery,
  refsVerdict,
  relationRefs,
  scopeQuery,
  scopedFilters,
  withoutAssigned,
  type Caller,
  type RecordAction,
  type Tables,
} from "./api-conditions";

// The core controller methods a content type with row conditions, assigned fields or a relation
// into a conditioned type is served by, copied into each generated Strapi project as
// src/permissions/api-controller.ts. A type's generated controller passes them to
// factories.createCoreController, which puts Strapi's own core controller under them as their
// prototype: `super` is that core controller.

interface RequestContext {
  params?: { id?: unknown };
  state?: unknown;
  request?: { body?: unknown };
  status?: number;
  notFound: () => unknown;
  forbidden: () => unknown;
  badRequest: (message?: string) => unknown;
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

/** The parts of Strapi itself they use: the type's document service and the query engine. */
interface StrapiServices {
  db: { query(uid: string): { findMany(params: object): Promise<unknown[]> } };
  service(uid: string): {
    find(params: object): Promise<{ results: unknown; pagination: unknown }>;
    findOne(documentId: string, params: object): Promise<unknown>;
    create(params: object): Promise<unknown>;
    update(documentId: string, params: object): Promise<unknown>;
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The body's data when it is an object; undefined for a missing or malformed payload. */
const requestData = (ctx: RequestContext): Record<string, unknown> | undefined => {
  const body = ctx.request?.body;
  return isObject(body) && isObject(body.data) ? body.data : undefined;
};

/** The body with its data replaced, so Strapi's own methods read the data as decided here. */
const replaceData = (ctx: RequestContext, data: Record<string, unknown>): void => {
  if (ctx.request !== undefined) ctx.request.body = { ...(ctx.request.body as object), data };
};

/**
 * The type's find, findOne, create, update and delete, each deciding on the caller's role before
 * Strapi's own: a list narrowed in the query (so paging and counts hold only what the caller may
 * read), an entry checked before it is read, changed or deleted, assigned fields filled from the
 * session on create and left out of an update, and every relation into a conditioned type
 * narrowed in populate and filters, and checked in writes.
 */
export const enforcedController = (strapiInstance: unknown, uid: string, tables: Tables) => {
  const strapi = strapiInstance as StrapiServices;
  const rules = tables.rules[uid]!;

  const verdict = async (caller: Caller, ctx: RequestContext, as: RecordAction) => {
    if (caller.kind === "unrestricted" || !rules.own) return "allow";
    if (caller.kind === "refused") return "forbidden";
    const rows = await strapi.db
      .query(uid)
      .findMany(recordQuery(rules, String(ctx.params?.id ?? "")));
    return recordVerdict(rules, caller, as, rows);
  };

  /** The validated, sanitized query, narrowed for the caller; a 400 when it cannot be. */
  const query = async (
    controller: CoreController,
    ctx: RequestContext,
  ): Promise<Record<string, unknown> | { refused: unknown }> => {
    await controller.validateQuery(ctx);
    const sanitized = await controller.sanitizeQuery(ctx);
    const scoped = scopeQuery(tables, uid, ctx.state, sanitized);
    return scoped.ok ? scoped.value : { refused: ctx.badRequest(scoped.message) };
  };

  /**
   * Whether the write is refused, the response already set: a 403 when the data links an entry
   * of a conditioned type the caller may not read (or one that does not exist), a 400 for a
   * relation value it cannot read. A boolean, since Strapi's response helpers return nothing.
   */
  const linksRefused = async (
    ctx: RequestContext,
    data: Record<string, unknown>,
  ): Promise<boolean> => {
    const refs = relationRefs(tables, uid, ctx.state, data);
    if (!refs.ok) {
      ctx.badRequest(refs.message);
      return true;
    }
    for (const ref of refs.value) {
      const rows = await strapi.db.query(ref.target).findMany(refsQuery(tables, ref));
      if (refsVerdict(tables, ctx.state, ref, rows) === "forbidden") {
        ctx.forbidden();
        return true;
      }
    }
    return false;
  };

  return {
    async find(this: CoreController, ctx: RequestContext) {
      const caller = callerOf(rules, ctx.state, "find");
      if (caller.kind === "refused") return ctx.forbidden();
      if (caller.kind === "unrestricted") return super.find(ctx);
      const scoped = await query(this, ctx);
      if ("refused" in scoped) return scoped.refused;
      const scope = listFilter(rules, caller);
      const filters = scope === null ? scoped.filters : scopedFilters(scoped.filters, scope);
      const { results, pagination } = await strapi
        .service(uid)
        .find({ ...scoped, ...(filters === undefined ? {} : { filters }) });
      const sanitized = await this.sanitizeOutput(results, ctx);
      return this.transformResponse(sanitized, { pagination });
    },

    async findOne(this: CoreController, ctx: RequestContext) {
      const caller = callerOf(rules, ctx.state, "findOne");
      if (caller.kind === "refused") return ctx.forbidden();
      if (caller.kind === "unrestricted") return super.findOne(ctx);
      const answer = await verdict(caller, ctx, "read");
      if (answer === "notFound") return ctx.notFound();
      if (answer === "forbidden") return ctx.forbidden();
      const scoped = await query(this, ctx);
      if ("refused" in scoped) return scoped.refused;
      const entity = await strapi.service(uid).findOne(String(ctx.params?.id ?? ""), scoped);
      if (entity === null || entity === undefined) return ctx.notFound();
      const sanitized = await this.sanitizeOutput(entity, ctx);
      return this.transformResponse(sanitized);
    },

    async create(this: CoreController, ctx: RequestContext) {
      const caller = callerOf(rules, ctx.state, "create");
      if (caller.kind === "refused") return ctx.forbidden();
      const sent = requestData(ctx);
      if (sent === undefined) {
        // A restricted caller's create is decided here, so a payload it cannot read is refused
        // here; Strapi's own create answers anyone else's.
        return caller.kind === "role"
          ? ctx.badRequest("Missing or invalid data")
          : super.create(ctx);
      }
      const data = withoutAssigned(caller, sent);
      if (createVerdict(rules, caller, data) === "forbidden") return ctx.forbidden();
      if (caller.kind === "role") {
        if (await linksRefused(ctx, data)) return undefined;
      }
      replaceData(ctx, data);
      const assigned = assignedValues(caller);
      if (caller.kind === "unrestricted" && Object.keys(assigned).length === 0)
        return super.create(ctx);
      // The assigned relation is added after validation: the role need not read the user type,
      // which Strapi's validator would demand of a relation the client wrote.
      const scoped = await query(this, ctx);
      if ("refused" in scoped) return scoped.refused;
      if (this.validateInput !== undefined) await this.validateInput(data, ctx);
      const input = await this.sanitizeInput(data, ctx);
      const entity = await strapi
        .service(uid)
        .create({ ...scoped, data: { ...input, ...assigned } });
      const sanitized = await this.sanitizeOutput(entity, ctx);
      ctx.status = 201;
      return this.transformResponse(sanitized);
    },

    async update(this: CoreController, ctx: RequestContext) {
      const caller = callerOf(rules, ctx.state, "update");
      if (caller.kind === "refused") return ctx.forbidden();
      const sent = requestData(ctx);
      if (caller.kind === "unrestricted") {
        if (sent !== undefined) replaceData(ctx, withoutAssigned(caller, sent));
        return super.update(ctx);
      }
      if (sent === undefined) return ctx.badRequest("Missing or invalid data");
      const answer = await verdict(caller, ctx, "update");
      if (answer === "notFound") return ctx.notFound();
      if (answer === "forbidden") return ctx.forbidden();
      const data = withoutAssigned(caller, sent);
      if (await linksRefused(ctx, data)) return undefined;
      replaceData(ctx, data);
      const scoped = await query(this, ctx);
      if ("refused" in scoped) return scoped.refused;
      if (this.validateInput !== undefined) await this.validateInput(data, ctx);
      const input = await this.sanitizeInput(data, ctx);
      const entity = await strapi
        .service(uid)
        .update(String(ctx.params?.id ?? ""), { ...scoped, data: input });
      if (entity === null || entity === undefined) return ctx.notFound();
      const sanitized = await this.sanitizeOutput(entity, ctx);
      return this.transformResponse(sanitized);
    },

    async delete(ctx: RequestContext) {
      const caller = callerOf(rules, ctx.state, "delete");
      if (caller.kind === "refused") return ctx.forbidden();
      const answer = await verdict(caller, ctx, "delete");
      if (answer === "notFound") return ctx.notFound();
      if (answer === "forbidden") return ctx.forbidden();
      return super.delete(ctx);
    },
  };
};
