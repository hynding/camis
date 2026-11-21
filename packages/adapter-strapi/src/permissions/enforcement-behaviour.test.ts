import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { strapiAdapter } from "../generate";
import { ownershipBundle } from "../__fixtures__/ownership";

// Strapi cannot be booted here, so the emitted enforcement modules run against a small fake of
// the surface they use: the request context, the core controller Strapi builds them on, its
// document service and its query engine. The fake core controller is what an unguarded request
// would reach: it serves every row and writes whatever the body says.

const UID = "api::note.note";

interface Row {
  id: number;
  documentId: string;
  title: string;
  shared: boolean;
  owner: { id: number; documentId: string } | null;
}

type Filter = Record<string, unknown>;

/** Strapi filter semantics for the operators the enforcement writes and a client might send. */
const matches = (row: Record<string, unknown>, filter: Filter): boolean =>
  Object.entries(filter).every(([key, cond]) => {
    if (key === "$and") return (cond as Filter[]).every((f) => matches(row, f));
    if (key === "$or") return (cond as Filter[]).some((f) => matches(row, f));
    const value = row[key];
    const ops = cond as Record<string, unknown>;
    if ("$eq" in ops) return value === ops.$eq;
    if ("$null" in ops) return (value === null || value === undefined) === ops.$null;
    // A relation: its own filter applies to the related row.
    return value !== null && typeof value === "object" && matches(value as Filter, ops as Filter);
  });

const user = (id: number, role: string) => ({
  id,
  documentId: `user-${id}`,
  email: `u${id}@example.test`,
  role: { type: role, name: role },
});
const asUser = (id: number, role: string) => ({
  auth: { strategy: { name: "users-permissions" }, credentials: user(id, role) },
  user: user(id, role),
});
const asGuest = { auth: { strategy: { name: "users-permissions" }, credentials: null } };
const asToken = { auth: { strategy: { name: "api-token" }, credentials: { type: "full-access" } } };

let rows: Row[];
const calls: string[] = [];
let seenInput: unknown[] = [];
let createdWith: unknown;

const store = (): Row[] => [
  {
    id: 1,
    documentId: "mine",
    title: "mine",
    shared: false,
    owner: { id: 10, documentId: "user-10" },
  },
  {
    id: 2,
    documentId: "theirs",
    title: "theirs",
    shared: false,
    owner: { id: 11, documentId: "user-11" },
  },
  {
    id: 3,
    documentId: "open",
    title: "open",
    shared: true,
    owner: { id: 11, documentId: "user-11" },
  },
];

const strapi = {
  db: {
    query: (uid: string) => ({
      findMany: async (params: { where: { documentId: string } }) => {
        expect(uid).toBe(UID);
        return rows.filter((r) => r.documentId === params.where.documentId);
      },
    }),
  },
  service: (uid: string) => ({
    find: async (params: { filters?: Filter }) => {
      expect(uid).toBe(UID);
      const results = rows.filter(
        (r) => params.filters === undefined || matches({ ...r }, params.filters),
      );
      return {
        results,
        pagination: { page: 1, pageSize: 25, pageCount: 1, total: results.length },
      };
    },
    create: async (params: { data: Record<string, unknown> }) => {
      createdWith = params.data;
      const row: Row = {
        id: rows.length + 1,
        documentId: `new-${rows.length + 1}`,
        title: String(params.data.title),
        shared: false,
        owner: null,
      };
      rows.push(row);
      return row;
    },
  }),
};

interface Context {
  params: { id?: string };
  query: Record<string, unknown>;
  state: unknown;
  request: { body?: { data?: Record<string, unknown> } };
  status?: number;
  notFound: () => unknown;
  forbidden: () => unknown;
}

const context = (state: unknown, extra: Partial<Context> = {}): Context => {
  const ctx: Context = {
    params: {},
    query: {},
    state,
    request: {},
    notFound: () => {
      ctx.status = 404;
      return { error: { status: 404, name: "NotFoundError" } };
    },
    forbidden: () => {
      ctx.status = 403;
      return { error: { status: 403, name: "ForbiddenError" } };
    },
    ...extra,
  };
  return ctx;
};

/** Strapi's core collection controller for the type: every row, every write, no questions. */
const coreController = () => ({
  validateQuery: async () => {},
  sanitizeQuery: async (ctx: Context) => ({ ...ctx.query }),
  validateInput: async (data: unknown) => {
    seenInput.push(data);
  },
  sanitizeInput: async (data: Record<string, unknown>) => ({ ...data }),
  sanitizeOutput: async (data: unknown) => data,
  transformResponse: (data: unknown, meta?: unknown) => ({ data, meta: meta ?? {} }),
  async find(ctx: Context) {
    calls.push("core.find");
    const { results, pagination } = await strapi.service(UID).find({ ...(ctx.query as object) });
    return { data: results, meta: { pagination } };
  },
  async findOne(ctx: Context) {
    calls.push("core.findOne");
    return { data: rows.find((r) => r.documentId === ctx.params.id) ?? null };
  },
  async create(ctx: Context) {
    calls.push("core.create");
    seenInput.push(ctx.request.body?.data);
    return { data: await strapi.service(UID).create({ data: ctx.request.body!.data! }) };
  },
  async update(ctx: Context) {
    calls.push("core.update");
    const row = rows.find((r) => r.documentId === ctx.params.id)!;
    const data = ctx.request.body!.data!;
    if (typeof data.title === "string") row.title = data.title;
    if (typeof data.owner === "number")
      row.owner = { id: data.owner, documentId: `user-${data.owner}` };
    return { data: row };
  },
  async delete(ctx: Context) {
    calls.push("core.delete");
    rows = rows.filter((r) => r.documentId !== ctx.params.id);
    return { data: null };
  },
});

type Action = (
  ctx: Context,
) => Promise<{ data: unknown; meta?: { pagination?: { total: number } } }>;
type Controller = Record<"find" | "findOne" | "create" | "update" | "delete", Action>;

let dir: string;
let controller: Controller;

/** Strapi 5's createCoreController: the core's methods under the given ones, as its prototype. */
const createCoreController = (factory: (p: { strapi: typeof strapi }) => object): Controller => {
  const base = coreController();
  const own = factory({ strapi }) as Record<string, unknown>;
  for (const [name, method] of Object.entries(base))
    if (own[name] === undefined) own[name] = method;
  Object.setPrototypeOf(own, base);
  return own as unknown as Controller;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "camis-enforcement-"));
  const result = strapiAdapter.generate(ownershipBundle, { projectName: "notes" });
  await mkdir(join(dir, "permissions"));
  for (const name of ["api-conditions.ts", "api-controller.ts"]) {
    const content = result.files.find((f) => f.path === `src/permissions/${name}`)!.content;
    await writeFile(join(dir, "permissions", name), content);
  }
  const conditions = await import(
    pathToFileURL(join(dir, "permissions", "api-conditions.ts")).href
  );
  const { enforcedController } = await import(
    pathToFileURL(join(dir, "permissions", "api-controller.ts")).href
  );
  controller = createCoreController(({ strapi: s }) =>
    enforcedController(s, UID, conditions.RULES[UID]),
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  rows = store();
  calls.length = 0;
  seenInput = [];
  createdWith = undefined;
});

const ids = (body: { data: unknown }): string[] => (body.data as Row[]).map((r) => r.documentId);

describe("a member, who manages only the notes it owns", () => {
  const member = () => asUser(10, "member");

  it("lists only its own notes, and the page counts only those", async () => {
    const body = await controller.find(context(member()));
    expect(ids(body)).toEqual(["mine"]);
    expect(body.meta?.pagination?.total).toBe(1);
    expect(calls).not.toContain("core.find");
  });
  it("cannot widen the list with a filter of its own", async () => {
    const wide = { $or: [{ owner: { id: { $eq: 11 } } }, { title: { $eq: "theirs" } }] };
    const body = await controller.find(context(member(), { query: { filters: wide } }));
    expect(ids(body)).toEqual([]);
    const narrowing = await controller.find(
      context(member(), { query: { filters: { title: { $eq: "mine" } } } }),
    );
    expect(ids(narrowing)).toEqual(["mine"]);
  });
  it("reads its own note, and is answered 404 for another's, which is never fetched", async () => {
    const own = context(member(), { params: { id: "mine" } });
    expect((await controller.findOne(own)).data).toMatchObject({ documentId: "mine" });
    const other = context(member(), { params: { id: "theirs" } });
    await controller.findOne(other);
    expect(other.status).toBe(404);
    expect(calls).toEqual(["core.findOne"]);
  });
  it("cannot update or delete another's note", async () => {
    const update = context(member(), {
      params: { id: "theirs" },
      request: { body: { data: { title: "x" } } },
    });
    await controller.update(update);
    expect(update.status).toBe(404);
    const del = context(member(), { params: { id: "theirs" } });
    await controller.delete(del);
    expect(del.status).toBe(404);
    expect(calls).toEqual([]);
    expect(rows.find((r) => r.documentId === "theirs")).toMatchObject({ title: "theirs" });
  });
  it("is answered 404 for a note that does not exist", async () => {
    const ctx = context(member(), { params: { id: "nope" } });
    await controller.delete(ctx);
    expect(ctx.status).toBe(404);
  });
  it("creates a note owned by itself, whatever owner the body names", async () => {
    const ctx = context(member(), { request: { body: { data: { title: "new", owner: 11 } } } });
    await controller.create(ctx);
    expect(ctx.status).toBe(201);
    expect(createdWith).toEqual({ title: "new", owner: { set: [{ documentId: "user-10" }] } });
    // Strapi's validator never sees the relation, which the role may not read.
    expect(seenInput).toEqual([{ title: "new" }]);
  });
  it("cannot move its own note to another owner", async () => {
    const ctx = context(member(), {
      params: { id: "mine" },
      request: { body: { data: { title: "edited", owner: 11 } } },
    });
    await controller.update(ctx);
    expect(calls).toEqual(["core.update"]);
    expect(rows.find((r) => r.documentId === "mine")).toMatchObject({
      title: "edited",
      owner: { id: 10 },
    });
  });
  it("deletes its own note", async () => {
    await controller.delete(context(member(), { params: { id: "mine" } }));
    expect(rows.map((r) => r.documentId)).toEqual(["theirs", "open"]);
  });
});

describe("a reviewer, who reads every note but edits only its own", () => {
  const reviewer = () => asUser(10, "reviewer");

  it("lists every note", async () => {
    expect(ids(await controller.find(context(reviewer())))).toEqual(["mine", "theirs", "open"]);
  });
  it("is answered 403 updating or deleting a note it may read but not edit", async () => {
    const update = context(reviewer(), {
      params: { id: "theirs" },
      request: { body: { data: { title: "x" } } },
    });
    await controller.update(update);
    expect(update.status).toBe(403);
    const del = context(reviewer(), { params: { id: "theirs" } });
    await controller.delete(del);
    expect(del.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("a guest, who holds the public role", () => {
  it("lists and reads only shared notes", async () => {
    expect(ids(await controller.find(context(asGuest)))).toEqual(["open"]);
    const hidden = context(asGuest, { params: { id: "theirs" } });
    await controller.findOne(hidden);
    expect(hidden.status).toBe(404);
  });
});

describe("callers no role restricts", () => {
  it("an admin role reaches every note through the core controller", async () => {
    expect(ids(await controller.find(context(asUser(12, "manager"))))).toEqual([
      "mine",
      "theirs",
      "open",
    ]);
    expect(calls).toEqual(["core.find"]);
  });
  // Strapi's API tokens stand for no role and no user (Phase 25): no row condition applies, and
  // an assigned owner is left unset rather than taken from the body.
  it("an API token reads every note, and cannot name an owner", async () => {
    expect(ids(await controller.find(context(asToken)))).toEqual(["mine", "theirs", "open"]);
    const ctx = context(asToken, { request: { body: { data: { title: "t", owner: 11 } } } });
    await controller.create(ctx);
    expect(seenInput).toEqual([{ title: "t" }]);
  });
});

describe("callers the rules do not know are refused", () => {
  it("a role the IR does not grant the type lists nothing and edits nothing", async () => {
    expect(ids(await controller.find(context(asUser(13, "stranger"))))).toEqual([]);
    const ctx = context(asUser(13, "stranger"), { params: { id: "theirs" } });
    await controller.delete(ctx);
    expect(ctx.status).toBe(403);
  });
  it("a session whose role was not loaded, or a request no strategy authenticated", async () => {
    const roleless = context({ user: { id: 10 } }, { params: { id: "mine" } });
    await controller.findOne(roleless);
    expect(roleless.status).toBe(403);
    const none = context({}, { request: { body: { data: { title: "x" } } } });
    await controller.create(none);
    expect(none.status).toBe(403);
    expect(calls).toEqual([]);
  });
});
