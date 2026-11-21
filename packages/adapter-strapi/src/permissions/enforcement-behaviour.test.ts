import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { strapiAdapter } from "../generate";
import { ownershipBundle } from "../__fixtures__/ownership";
import type { IrBundle } from "@camis/permissions";
import { tokenState } from "../__fixtures__/token-states";

// Strapi cannot be booted here, so the emitted enforcement modules run against a small fake of
// the surface they use: the request context, the core controller Strapi builds them on, its
// document service (with filters and populate) and its query engine. The fake core controller is
// what an unguarded request would reach: it serves every row and writes whatever the body says.

const NOTE = "api::note.note";
const TAG = "api::tag.tag";
const CATEGORY = "api::category.category";
const BOOKMARK = "api::bookmark.bookmark";
const FRONT = "api::front.front";

type Row = Record<string, unknown> & { id: number; documentId: string };
type Filter = Record<string, unknown>;

/** Which attributes of each type are relations (to which type) or repeatable components. */
const SCHEMA: Record<string, Record<string, { relation: string } | { component: string }>> = {
  [NOTE]: {
    owner: { relation: "user" },
    category: { relation: CATEGORY },
    pinned: { relation: TAG },
    attachment: { relation: "file" },
  },
  [CATEGORY]: { notes: { relation: NOTE } },
  [TAG]: {
    note: { relation: NOTE },
    parent: { relation: TAG },
    pinnedOn: { relation: NOTE },
    refs: { component: "shared.reference" },
  },
  "shared.reference": { note: { relation: NOTE } },
  [BOOKMARK]: { parent: { relation: BOOKMARK } },
  [FRONT]: { featured: { relation: CATEGORY } },
};

/**
 * Strapi filter semantics for the operators the enforcement writes and a client might send, in
 * two-valued logic: it cannot show what SQL's NULLs do to a filter (a NOT of an unknown is
 * unknown), so runtime/engine.test.ts runs the scoped queries on Strapi's own query engine.
 */
const matches = (row: unknown, filter: Filter): boolean =>
  Object.entries(filter).every(([key, cond]) => {
    if (key === "$and") return (cond as Filter[]).every((f) => matches(row, f));
    if (key === "$or") return (cond as Filter[]).some((f) => matches(row, f));
    if (key === "$not") return !matches(row, cond as Filter);
    const value = (row as Record<string, unknown> | null)?.[key];
    if (typeof cond !== "object" || cond === null) return value === cond;
    const ops = cond as Record<string, unknown>;
    if ("$eq" in ops) return value === ops.$eq;
    if ("$ne" in ops) return value !== ops.$ne;
    if ("$in" in ops) return (ops.$in as unknown[]).includes(value);
    if ("$null" in ops) return (value === null || value === undefined) === ops.$null;
    if ("$notNull" in ops) return (value !== null && value !== undefined) === ops.$notNull;
    // A relation or a component: its own filter applies to the related rows (any of them).
    if (Array.isArray(value)) return value.some((v) => matches(v, ops));
    return value !== null && typeof value === "object" && matches(value, ops);
  });

/** A row as the document service returns it: scalars, plus what `populate` asks for. */
const shape = (
  row: Record<string, unknown>,
  uid: string,
  populate: unknown,
): Record<string, unknown> => {
  const schema = SCHEMA[uid] ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (!(key in schema)) out[key] = value;
  // A string or a list names attributes to populate whole (the only forms the core reaches here).
  const names = (list: string[]): Record<string, unknown> =>
    Object.fromEntries(
      list.flatMap((n) => (n === "*" ? Object.keys(schema) : [n])).map((k) => [k, true]),
    );
  const entries: Record<string, unknown> =
    typeof populate === "string"
      ? names(populate.split(","))
      : Array.isArray(populate)
        ? names(populate as string[])
        : typeof populate === "object" && populate !== null
          ? (populate as Record<string, unknown>)
          : {};
  for (const [key, entry] of Object.entries(entries)) {
    const link = schema[key];
    if (link === undefined || entry === false) continue;
    const options = typeof entry === "object" && entry !== null ? (entry as Filter) : {};
    const value = row[key];
    if ("component" in link) {
      out[key] = ((value as Record<string, unknown>[] | undefined) ?? []).map((c) =>
        shape(c, link.component, options.populate),
      );
      continue;
    }
    const related = value as Record<string, unknown> | null | undefined;
    const visible =
      related != null &&
      (options.filters === undefined || matches(related, options.filters as Filter));
    out[key] = visible ? shape(related, link.relation, options.populate) : null;
  }
  return out;
};

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
const asToken = tokenState("full-access");
const member = () => asUser(10, "member");

const tables: Record<string, Row[]> = {};
const calls: string[] = [];
let seenInput: unknown[] = [];
let createdWith: unknown;

const owner = (id: number) => ({ id, documentId: `user-${id}` });
const seed = (): void => {
  const mine: Row = { id: 1, documentId: "mine", title: "mine", shared: false, owner: owner(10) };
  const theirs: Row = {
    id: 2,
    documentId: "theirs",
    title: "theirs",
    shared: false,
    owner: owner(11),
  };
  const open: Row = { id: 3, documentId: "open", title: "open", shared: true, owner: owner(11) };
  const t1: Row = {
    id: 1,
    documentId: "t1",
    label: "t1",
    note: theirs,
    parent: null,
    refs: [{ note: theirs }],
  };
  const t2: Row = { id: 2, documentId: "t2", label: "t2", note: open, parent: t1, refs: [] };
  const t3: Row = { id: 3, documentId: "t3", label: "t3", note: mine, parent: null, refs: [] };
  // theirs pins t1; a category holds theirs.
  theirs.pinned = [t1];
  mine.pinned = [];
  t1.pinnedOn = theirs;
  const c1: Row = { id: 1, documentId: "c1", label: "c1", notes: [theirs] };
  const c2: Row = { id: 2, documentId: "c2", label: "c2", notes: [] };
  tables[NOTE] = [mine, theirs, open];
  tables[TAG] = [t1, t2, t3];
  tables[CATEGORY] = [c1, c2];
  const b1: Row = { id: 1, documentId: "b1", label: "b1", parent: null };
  tables[FRONT] = [{ id: 1, documentId: "front", headline: "hello", featured: c1 }];
  tables[BOOKMARK] = [b1, { id: 2, documentId: "b2", label: "b2", parent: b1 }];
};
const rowsOf = (uid: string): Row[] => tables[uid]!;
const byDocument = (uid: string, documentId: unknown) =>
  rowsOf(uid).find((r) => r.documentId === documentId);

/** A relation value as Strapi's document service resolves it: a document id or a connect list. */
const resolve = (uid: string, value: unknown): unknown => {
  if (typeof value === "string") return byDocument(uid, value) ?? null;
  if (typeof value === "object" && value !== null && "connect" in value) {
    const [first] = (value as { connect: unknown[] }).connect;
    return resolve(
      uid,
      typeof first === "object" && first !== null ? (first as Row).documentId : first,
    );
  }
  return value;
};

const strapi = {
  db: {
    query: (uid: string) => ({
      findMany: async (params: { where: Filter }) =>
        rowsOf(uid).filter((r) => matches(r, params.where)),
    }),
  },
  service: (uid: string) => ({
    find: async (params: { filters?: Filter; populate?: unknown }) => {
      const results = rowsOf(uid)
        .filter((r) => params.filters === undefined || matches(r, params.filters))
        .map((r) => shape(r, uid, params.populate));
      return {
        results,
        pagination: { page: 1, pageSize: 25, pageCount: 1, total: results.length },
      };
    },
    findOne: async (documentId: string, params: { populate?: unknown }) => {
      const row = byDocument(uid, documentId);
      return row === undefined ? null : shape(row, uid, params.populate);
    },
    create: async (params: { data: Record<string, unknown>; populate?: unknown }) => {
      createdWith = params.data;
      const data = { ...params.data };
      for (const [key, link] of Object.entries(SCHEMA[uid] ?? {}))
        if ("relation" in link && key in data) data[key] = resolve(link.relation, data[key]);
      const row: Row = {
        ...data,
        id: rowsOf(uid).length + 1,
        documentId: `new-${rowsOf(uid).length + 1}`,
      };
      rowsOf(uid).push(row);
      return shape(row, uid, params.populate);
    },
    update: async (
      documentId: string,
      params: { data: Record<string, unknown>; populate?: unknown },
    ) => {
      const row = byDocument(uid, documentId);
      if (row === undefined) return null;
      Object.assign(row, params.data);
      return shape(row, uid, params.populate);
    },
  }),
};

interface Context {
  params: { id?: string };
  query: Record<string, unknown>;
  state: unknown;
  request: { body?: { data?: unknown } };
  status?: number;
  body?: unknown;
  notFound: () => void;
  forbidden: () => void;
  badRequest: (message?: string) => void;
}

const context = (state: unknown, extra: Partial<Context> = {}): Context => {
  const ctx: Context = {
    params: {},
    query: {},
    state,
    request: {},
    // Strapi's helpers set the response and return nothing (a real boot showed a create carry
    // on past a refusal that relied on their return value), so these return nothing either.
    notFound: () => {
      ctx.status = 404;
      ctx.body = { data: null, error: { status: 404, name: "NotFoundError" } };
    },
    forbidden: () => {
      ctx.status = 403;
      ctx.body = { data: null, error: { status: 403, name: "ForbiddenError" } };
    },
    badRequest: () => {
      ctx.status = 400;
      ctx.body = { data: null, error: { status: 400, name: "ValidationError" } };
    },
    ...extra,
  };
  return ctx;
};

/** Strapi's core collection controller for a type: every row, every write, no questions. */
const coreController = (uid: string) => ({
  validateQuery: async () => {},
  sanitizeQuery: async (ctx: Context) => ({ ...ctx.query }),
  validateInput: async (data: unknown) => {
    seenInput.push(data);
  },
  sanitizeInput: async (data: Record<string, unknown>) => ({ ...data }),
  sanitizeOutput: async (data: unknown) => data,
  transformResponse: (data: unknown, meta?: unknown) => ({ data, meta: meta ?? {} }),
  async find(ctx: Context) {
    calls.push(`core.find ${uid}`);
    const { results, pagination } = await strapi.service(uid).find({ ...ctx.query });
    return { data: results, meta: { pagination } };
  },
  async findOne(ctx: Context) {
    calls.push(`core.findOne ${uid}`);
    return { data: await strapi.service(uid).findOne(String(ctx.params.id), { ...ctx.query }) };
  },
  async create(ctx: Context) {
    calls.push(`core.create ${uid}`);
    const data = ctx.request.body?.data as Record<string, unknown>;
    seenInput.push(data);
    return { data: await strapi.service(uid).create({ data }) };
  },
  async update(ctx: Context) {
    calls.push(`core.update ${uid}`);
    const data = ctx.request.body?.data as Record<string, unknown>;
    return { data: await strapi.service(uid).update(String(ctx.params.id), { data }) };
  },
  async delete(ctx: Context) {
    calls.push(`core.delete ${uid}`);
    // Strapi's deleteDocument reads the query's filters into its where, beside the document id.
    const filters = ctx.query.filters as Filter | undefined;
    tables[uid] = rowsOf(uid).filter(
      (r) => r.documentId !== ctx.params.id || (filters !== undefined && !matches(r, filters)),
    );
    return { data: null };
  },
});

interface Body {
  data: unknown;
  meta?: { pagination?: { total: number } };
}
type Action = (ctx: Context) => Promise<Body>;
type Controller = Record<"find" | "findOne" | "create" | "update" | "delete", Action>;

let dir: string;
const controllers: Record<string, Controller> = {};

/** Strapi 5's createCoreController: the core's methods under the given ones, as its prototype. */
const createCoreController = (uid: string, factory: (p: { strapi: typeof strapi }) => object) => {
  const base = coreController(uid);
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
  for (const name of [
    "api-conditions.ts",
    "api-controller.ts",
    "api-uploads.ts",
    "api-upload-controller.ts",
  ]) {
    const content = result.files.find((f) => f.path === `src/permissions/${name}`)!.content;
    await writeFile(join(dir, "permissions", name), content);
  }
  const { TABLES } = await import(
    pathToFileURL(join(dir, "permissions", "api-conditions.ts")).href
  );
  const { enforcedController } = await import(
    pathToFileURL(join(dir, "permissions", "api-controller.ts")).href
  );
  for (const uid of [NOTE, TAG, CATEGORY])
    controllers[uid] = createCoreController(uid, ({ strapi: s }) =>
      enforcedController(s, uid, TABLES),
    );
  const { checkedSingle } = await import(
    pathToFileURL(join(dir, "permissions", "api-controller.ts")).href
  );
  controllers[FRONT] = createCoreController(FRONT, () => checkedSingle(FRONT, TABLES));
  // A type with no rules of its own and nothing it reaches, served only so a restricted write's
  // body is checked: members create and update bookmarks, each under a parent bookmark.
  const withBookmarks: IrBundle = {
    document: {
      ...ownershipBundle.document,
      contentTypes: [
        ...ownershipBundle.document.contentTypes,
        {
          name: "Bookmark",
          kind: "collection",
          fields: [
            { type: "string", name: "label" },
            { type: "relation", name: "parent", relationKind: "manyToOne", target: "Bookmark" },
          ],
        },
      ],
    },
    roles: ownershipBundle.roles.map((r) =>
      r.name === "member"
        ? {
            ...r,
            grants: [
              ...r.grants,
              { contentType: "Bookmark", actions: ["create", "read", "update", "delete"] },
            ],
          }
        : r,
    ),
  };
  const bookmarks = strapiAdapter.generate(withBookmarks, { projectName: "notes" });
  await mkdir(join(dir, "bookmarks"));
  for (const name of [
    "api-conditions.ts",
    "api-controller.ts",
    "api-uploads.ts",
    "api-upload-controller.ts",
  ]) {
    const content = bookmarks.files.find((f) => f.path === `src/permissions/${name}`)!.content;
    await writeFile(join(dir, "bookmarks", name), content);
  }
  const bookmarkTables = (
    await import(pathToFileURL(join(dir, "bookmarks", "api-conditions.ts")).href)
  ).TABLES;
  const bookmarkController = (
    await import(pathToFileURL(join(dir, "bookmarks", "api-controller.ts")).href)
  ).enforcedController;
  controllers[BOOKMARK] = createCoreController(BOOKMARK, ({ strapi: s }) =>
    bookmarkController(s, BOOKMARK, bookmarkTables),
  );
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  seed();
  calls.length = 0;
  seenInput = [];
  createdWith = undefined;
});

const notes = () => controllers[NOTE]!;
const tags = () => controllers[TAG]!;
const categories = () => controllers[CATEGORY]!;
const documentIds = (body: Body): string[] => (body.data as Row[]).map((r) => r.documentId);
const field = (body: Body, documentId: string, key: string): unknown =>
  (body.data as Row[]).find((r) => r.documentId === documentId)?.[key];

describe("a member, who manages only the notes it owns", () => {
  it("lists only its own notes, and the page counts only those", async () => {
    const body = await notes().find(context(member()));
    expect(documentIds(body)).toEqual(["mine"]);
    expect(body.meta?.pagination?.total).toBe(1);
    expect(calls).toEqual([]);
  });
  it("cannot widen the list with a filter of its own", async () => {
    const wide = { $or: [{ owner: { id: { $eq: 11 } } }, { title: { $eq: "theirs" } }] };
    expect(
      documentIds(await notes().find(context(member(), { query: { filters: wide } }))),
    ).toEqual([]);
    const narrowing = { title: { $eq: "mine" } };
    expect(
      documentIds(await notes().find(context(member(), { query: { filters: narrowing } }))),
    ).toEqual(["mine"]);
  });
  it("reads its own note, and is answered 404 for another's, which is never fetched", async () => {
    const own = await notes().findOne(context(member(), { params: { id: "mine" } }));
    expect(own.data).toMatchObject({ documentId: "mine" });
    const other = context(member(), { params: { id: "theirs" } });
    await notes().findOne(other);
    expect(other.status).toBe(404);
  });
  it("cannot update or delete another's note", async () => {
    const update = context(member(), {
      params: { id: "theirs" },
      request: { body: { data: { title: "x" } } },
    });
    await notes().update(update);
    expect(update.status).toBe(404);
    const del = context(member(), { params: { id: "theirs" } });
    await notes().delete(del);
    expect(del.status).toBe(404);
    expect(calls).toEqual([]);
    expect(byDocument(NOTE, "theirs")).toMatchObject({ title: "theirs" });
  });
  it("is answered 404 for a note that does not exist", async () => {
    const ctx = context(member(), { params: { id: "nope" } });
    await notes().delete(ctx);
    expect(ctx.status).toBe(404);
  });
  it("creates a note owned by itself, whatever owner the body names", async () => {
    const ctx = context(member(), { request: { body: { data: { title: "new", owner: 11 } } } });
    await notes().create(ctx);
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
    await notes().update(ctx);
    expect(byDocument(NOTE, "mine")).toMatchObject({ title: "edited", owner: { id: 10 } });
  });
  it("deletes its own note", async () => {
    await notes().delete(context(member(), { params: { id: "mine" } }));
    expect(rowsOf(NOTE).map((r) => r.documentId)).toEqual(["theirs", "open"]);
  });
  // Strapi's delete reads the query's filters into its where, and its update finds the row to
  // write by them (creating a new one when none matches): a filter through a relation would
  // decide whether an entry the caller may change is changed, an oracle on what it reaches.
  it("refuses a delete query beyond locale and status, and filters on an update", async () => {
    for (const title of ["theirs", "wrong"]) {
      for (const query of [
        { filters: { category: { notes: { title: { $eq: title } } } } },
        { filters: { $not: { pinned: { note: { title: { $eq: title } } } } } },
      ]) {
        const del = context(member(), { params: { id: "mine" }, query });
        await notes().delete(del);
        expect(del.status, JSON.stringify(query)).toBe(400);
        const upd = context(member(), {
          params: { id: "mine" },
          query,
          request: { body: { data: { title: "edited" } } },
        });
        await notes().update(upd);
        expect(upd.status, JSON.stringify(query)).toBe(400);
      }
    }
    for (const query of [{ populate: "*" }, { sort: "title" }, { fields: ["title"] }]) {
      const del = context(member(), { params: { id: "mine" }, query });
      await notes().delete(del);
      expect(del.status, JSON.stringify(query)).toBe(400);
    }
    expect(byDocument(NOTE, "mine")).toMatchObject({ title: "mine" });
    expect(calls.filter((c) => c.startsWith("core.delete") || c.startsWith("core.update"))).toEqual(
      [],
    );
    await notes().delete(context(member(), { params: { id: "mine" }, query: { locale: "en" } }));
    expect(byDocument(NOTE, "mine")).toBeUndefined();
  });
  // A draft and its published version are two rows of one entry: both must pass.
  it("is refused an entry whose draft it owns but whose published version it does not", async () => {
    rowsOf(NOTE).push({
      id: 9,
      documentId: "mine",
      title: "mine",
      shared: false,
      owner: owner(11),
    });
    const read = context(member(), { params: { id: "mine" } });
    await notes().findOne(read);
    expect(read.status).toBe(404);
    const update = context(member(), {
      params: { id: "mine" },
      request: { body: { data: { title: "x" } } },
    });
    await notes().update(update);
    expect(update.status).toBe(404);
    expect(calls).toEqual([]);
  });
  it("is answered 400 for a create or update whose data is not an object, before Strapi sees it", async () => {
    for (const data of [[], "x", null]) {
      const create = context(member(), { request: { body: { data } } });
      await notes().create(create);
      expect(create.status, JSON.stringify(data)).toBe(400);
      const update = context(member(), { params: { id: "mine" }, request: { body: { data } } });
      await notes().update(update);
      expect(update.status, JSON.stringify(data)).toBe(400);
    }
    expect(calls).toEqual([]);
    expect(rowsOf(NOTE)).toHaveLength(3);
  });
});

describe("create conditions", () => {
  // A contributor may only add private notes; a note is shared unless it says otherwise.
  it("refuses a create whose omitted field defaults to a value the condition forbids", async () => {
    const omitted = context(asUser(12, "contributor"), {
      request: { body: { data: { title: "c" } } },
    });
    await notes().create(omitted);
    expect(omitted.status).toBe(403);
    const shared = context(asUser(12, "contributor"), {
      request: { body: { data: { title: "c", shared: true } } },
    });
    await notes().create(shared);
    expect(shared.status).toBe(403);
    expect(rowsOf(NOTE)).toHaveLength(3);
    const ok = context(asUser(12, "contributor"), {
      request: { body: { data: { title: "c", shared: false } } },
    });
    await notes().create(ok);
    expect(ok.status).toBe(201);
  });
  it("refuses a guest's create, which the public role does not hold", async () => {
    const ctx = context(asGuest, { request: { body: { data: { title: "g" } } } });
    await notes().create(ctx);
    expect(ctx.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("a reviewer, who reads every note but edits only its own", () => {
  const reviewer = () => asUser(10, "reviewer");
  it("lists every note", async () => {
    expect(documentIds(await notes().find(context(reviewer())))).toEqual([
      "mine",
      "theirs",
      "open",
    ]);
  });
  it("is answered 403 updating or deleting a note it may read but not edit", async () => {
    const update = context(reviewer(), {
      params: { id: "theirs" },
      request: { body: { data: { title: "x" } } },
    });
    await notes().update(update);
    expect(update.status).toBe(403);
    const del = context(reviewer(), { params: { id: "theirs" } });
    await notes().delete(del);
    expect(del.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("a guest, who holds the public role", () => {
  it("lists and reads only shared notes", async () => {
    expect(documentIds(await notes().find(context(asGuest)))).toEqual(["open"]);
    const hidden = context(asGuest, { params: { id: "theirs" } });
    await notes().findOne(hidden);
    expect(hidden.status).toBe(404);
  });
});

describe("tags reach notes: a populate, a filter or a link carries the note's condition", () => {
  const list = (state: unknown, query: Record<string, unknown>) =>
    tags().find(context(state, { query }));

  it("populates only the notes the caller may read", async () => {
    const body = await list(member(), { populate: "note" });
    expect(field(body, "t1", "note")).toBeNull();
    expect(field(body, "t2", "note")).toBeNull();
    expect(field(body, "t3", "note")).toMatchObject({ documentId: "mine" });
    const guest = await list(asGuest, { populate: ["note"] });
    expect(field(guest, "t1", "note")).toBeNull();
    expect(field(guest, "t2", "note")).toMatchObject({ documentId: "open" });
  });
  it("narrows populate=*, a nested populate and a component's relation as well", async () => {
    expect(field(await list(member(), { populate: "*" }), "t1", "note")).toBeNull();
    const nested = await list(member(), { populate: { parent: { populate: { note: true } } } });
    expect(field(nested, "t2", "parent")).toMatchObject({ documentId: "t1", note: null });
    const dotted = await list(member(), { populate: "parent.note" });
    expect(field(dotted, "t2", "parent")).toMatchObject({ documentId: "t1", note: null });
    const component = await list(member(), { populate: { refs: { populate: ["note"] } } });
    expect(field(component, "t1", "refs")).toEqual([{ note: null }]);
  });
  it("narrows a populate on one entry too", async () => {
    const one = await tags().findOne(
      context(member(), { params: { id: "t1" }, query: { populate: "*" } }),
    );
    expect(one.data).toMatchObject({ documentId: "t1", note: null });
  });
  it("answers a filter on another member's note as if it were not there", async () => {
    const oracle = await list(member(), { filters: { note: { title: { $eq: "theirs" } } } });
    expect(documentIds(oracle)).toEqual([]);
    const own = await list(member(), { filters: { note: { title: { $eq: "mine" } } } });
    expect(documentIds(own)).toEqual(["t3"]);
  });
  it("refuses a sort through the note, with 400", async () => {
    const ctx = context(member(), { query: { sort: "note.title:asc" } });
    await tags().find(ctx);
    expect(ctx.status).toBe(400);
  });
  it("refuses to link another member's note, by document id, connect or a component", async () => {
    for (const data of [
      { label: "x", note: "theirs" },
      { label: "x", note: { connect: [{ documentId: "theirs" }] } },
      { label: "x", note: { connect: [2] } },
      { label: "x", refs: [{ note: "theirs" }] },
      { label: "x", note: "nope" },
    ]) {
      const ctx = context(member(), { request: { body: { data } } });
      await tags().create(ctx);
      expect(ctx.status, JSON.stringify(data)).toBe(403);
    }
    expect(rowsOf(TAG)).toHaveLength(3);
    const ok = context(member(), { request: { body: { data: { label: "y", note: "mine" } } } });
    await tags().create(ok);
    expect(ok.status).toBe(201);
  });
  it("leaves a tag list alone for a caller no condition narrows", async () => {
    const body = await list(asToken, { populate: "note" });
    expect(field(body, "t1", "note")).toMatchObject({ documentId: "theirs" });
    expect(calls).toEqual([`core.find ${TAG}`]);
  });
});

describe("a relation write needs update on every entry it changes", () => {
  const reviewer = () => asUser(10, "reviewer");
  const write = async (
    controller: Controller,
    state: unknown,
    id: string | undefined,
    data: unknown,
  ): Promise<number | undefined> => {
    const ctx = context(state, {
      ...(id === undefined ? {} : { params: { id } }),
      request: { body: { data } },
    });
    await (id === undefined ? controller.create(ctx) : controller.update(ctx));
    return ctx.status;
  };
  // A reviewer reads every note and updates its own; writing a category's notes changes the
  // notes, whose category is the same link.
  it("refuses to connect, disconnect or replace a category's notes the reviewer may not update", async () => {
    for (const data of [
      { notes: { connect: ["theirs"] } },
      { notes: { disconnect: ["theirs"] } },
      { notes: { set: [] } },
      { notes: [] },
      { notes: null },
    ])
      expect(await write(categories(), reviewer(), "c1", data), JSON.stringify(data)).toBe(403);
    expect(byDocument(CATEGORY, "c1")!.notes).toEqual([byDocument(NOTE, "theirs")]);
    expect(calls).toEqual([]);
    expect(await write(categories(), reviewer(), "c2", { notes: { connect: ["mine"] } })).toBe(
      undefined,
    );
    expect(await write(categories(), reviewer(), "c2", { label: "renamed" })).toBe(undefined);
  });
  // A tag is pinned on one note at most: pinning it on mine takes it from theirs.
  it("refuses to take a pinned tag from another member's note", async () => {
    expect(await write(notes(), member(), "mine", { pinned: { connect: ["t1"] } })).toBe(403);
    expect(await write(notes(), member(), "mine", { pinned: { connect: ["t3"] } })).toBe(undefined);
  });
  it("refuses a tag that pins itself on another member's note, which shows the link", async () => {
    expect(await write(tags(), member(), undefined, { label: "x", pinnedOn: "theirs" })).toBe(403);
    expect(await write(tags(), member(), undefined, { label: "x", pinnedOn: "mine" })).toBe(201);
  });
});

describe("a file's related entries", () => {
  it("are refused with 400 under a note's attachment", async () => {
    const ctx = context(member(), {
      query: { populate: { attachment: { populate: { related: true } } } },
    });
    await notes().find(ctx);
    expect(ctx.status).toBe(400);
    const plain = context(member(), { query: { populate: "attachment" } });
    await notes().find(plain);
    expect(plain.status).toBeUndefined();
  });
});

describe("callers no role restricts", () => {
  it("an admin role reaches every note through the core controller", async () => {
    expect(documentIds(await notes().find(context(asUser(12, "manager"))))).toEqual([
      "mine",
      "theirs",
      "open",
    ]);
    expect(calls).toEqual([`core.find ${NOTE}`]);
  });
  // Strapi's API tokens stand for no role and no user (Phase 25): no row condition applies, and
  // an assigned owner is left unset rather than taken from the body.
  it("an API token reads every note, and cannot name an owner", async () => {
    expect(documentIds(await notes().find(context(asToken)))).toEqual(["mine", "theirs", "open"]);
    const ctx = context(asToken, { request: { body: { data: { title: "t", owner: 11 } } } });
    await notes().create(ctx);
    expect(seenInput).toEqual([{ title: "t" }]);
  });
});

// A content API token stands for no role: a full-access or read-only one reads every type, so its
// requests are Strapi's as they come; a custom one is checked against its own scopes by Strapi,
// whose sanitizer keeps a polymorphic list whole when the token may read none of its entries, so a
// populate of a file's related entries is refused for it as for a role, and nothing else is.
describe("API tokens, by their type", () => {
  const related = { attachment: { populate: { related: true } } };
  it("passes a full-access or read-only token's request to Strapi, related entries included", async () => {
    for (const type of ["full-access", "read-only"] as const) {
      const ctx = context(tokenState(type), { query: { populate: related } });
      await notes().find(ctx);
      expect(ctx.status, type).toBeUndefined();
    }
    expect(calls).toEqual([`core.find ${NOTE}`, `core.find ${NOTE}`]);
  });
  it("refuses a custom token's populate of a file's related entries, on a read or a write", async () => {
    const custom = tokenState("custom");
    for (const method of ["find", "findOne"] as const) {
      const ctx = context(custom, { params: { id: "mine" }, query: { populate: related } });
      await notes()[method](ctx);
      expect(ctx.status, method).toBe(400);
    }
    const write = context(custom, {
      query: { populate: related },
      request: { body: { data: { title: "t" } } },
    });
    await notes().create(write);
    expect(write.status).toBe(400);
    const deep = context(custom, {
      query: { populate: { note: { populate: { attachment: { populate: "related" } } } } },
    });
    await tags().find(deep);
    expect(deep.status).toBe(400);
    expect(calls).toEqual([]);
  });
  it("leaves a custom token's other requests to Strapi, unnarrowed", async () => {
    const custom = tokenState("custom");
    expect(
      documentIds(await notes().find(context(custom, { query: { populate: "attachment" } }))),
    ).toEqual(["mine", "theirs", "open"]);
    expect(calls).toEqual([`core.find ${NOTE}`]);
  });
});

describe("callers the rules do not know are refused", () => {
  it("a role the IR does not grant the type lists nothing and edits nothing", async () => {
    expect(documentIds(await notes().find(context(asUser(13, "stranger"))))).toEqual([]);
    const ctx = context(asUser(13, "stranger"), { params: { id: "theirs" } });
    await notes().delete(ctx);
    expect(ctx.status).toBe(403);
  });
  it("a role named like an Object prototype property is a stranger, not a crash", async () => {
    for (const role of ["constructor", "toString", "__proto__"]) {
      const ctx = context(asUser(13, role), { request: { body: { data: { title: "x" } } } });
      await notes().create(ctx);
      expect(ctx.status, role).toBe(403);
      const update = context(asUser(13, role), {
        params: { id: "mine" },
        request: { body: { data: { title: "x" } } },
      });
      await notes().update(update);
      expect(update.status, role).toBe(403);
    }
  });
  it("a session whose role was not loaded, or a request no strategy authenticated", async () => {
    const roleless = context({ user: { id: 10 } }, { params: { id: "mine" } });
    await notes().findOne(roleless);
    expect(roleless.status).toBe(403);
    const none = context({}, { request: { body: { data: { title: "x" } } } });
    await notes().create(none);
    expect(none.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

// Strapi's database layer spreads a relation item's __pivot into the join row: on a type with no
// rules, a member with create alone could otherwise add links to existing entries.
describe("a type with no rules, served only to check a restricted write's body", () => {
  const bookmarks = () => controllers[BOOKMARK]!;
  it("creates and updates as Strapi does", async () => {
    const created = context(member(), {
      request: { body: { data: { label: "new", parent: "b2" } } },
    });
    await bookmarks().create(created);
    expect(created.status).toBe(201);
    expect(rowsOf(BOOKMARK).map((r) => r.label)).toEqual(["b1", "b2", "new"]);
    const updated = context(member(), {
      params: { id: "b1" },
      request: { body: { data: { label: "edited", parent: { connect: [{ id: 2 }] } } } },
    });
    await bookmarks().update(updated);
    expect(updated.status).toBeUndefined();
    expect(byDocument(BOOKMARK, "b1")).toMatchObject({ label: "edited" });
  });
  it("refuses a __pivot, or any key that is no attribute, before Strapi sees the write", async () => {
    for (const data of [
      { label: "x", parent: { connect: [{ id: 1, __pivot: { bookmark_id: 2 } }] } },
      { label: "x", documentId: "b1" },
    ]) {
      const create = context(member(), { request: { body: { data } } });
      await bookmarks().create(create);
      expect(create.status, JSON.stringify(data)).toBe(400);
      const update = context(member(), { params: { id: "b1" }, request: { body: { data } } });
      await bookmarks().update(update);
      expect(update.status, JSON.stringify(data)).toBe(400);
    }
    expect(rowsOf(BOOKMARK).map((r) => [r.documentId, r.label])).toEqual([
      ["b1", "b1"],
      ["b2", "b2"],
    ]);
  });
  it("leaves reads and deletes to Strapi's own controller, query parameters and all", async () => {
    await bookmarks().find(context(member(), { query: { publicationFilter: "never-published" } }));
    await bookmarks().findOne(context(member(), { params: { id: "b1" } }));
    await bookmarks().delete(context(member(), { params: { id: "b1" }, query: { filters: {} } }));
    expect(calls).toEqual([
      `core.find ${BOOKMARK}`,
      `core.findOne ${BOOKMARK}`,
      `core.delete ${BOOKMARK}`,
    ]);
  });
});

// Strapi's single type controller writes through the same database layer, which spreads a
// relation item's __pivot into the join row: a restricted caller's body is checked first.
describe("a single type a restricted role writes, over Strapi's single type controller", () => {
  const front = () => controllers[FRONT]!;
  const reviewer = () => asUser(12, "reviewer");
  it("passes a write of its attributes on to Strapi's own update", async () => {
    const ctx = context(reviewer(), {
      request: { body: { data: { headline: "new", featured: { connect: [{ id: 2 }] } } } },
    });
    await front().update(ctx);
    expect(ctx.status).toBeUndefined();
    expect(calls).toEqual([`core.update ${FRONT}`]);
  });
  it("refuses a __pivot or a key that is no attribute, before Strapi sees it", async () => {
    for (const data of [
      { featured: { connect: [{ id: 2, __pivot: { front_id: 9 } }] } },
      { featured: { set: [2], connect: [1] } },
      { headline: "x", publishedAt: null },
      { locale: "fr" },
    ]) {
      const ctx = context(reviewer(), { request: { body: { data } } });
      await front().update(ctx);
      expect(ctx.status, JSON.stringify(data)).toBe(400);
    }
    const guest = context(asGuest, {
      request: { body: { data: { featured: { connect: [{ id: 2, __pivot: {} }] } } } },
    });
    await front().update(guest);
    expect(guest.status).toBe(400);
    expect(calls).toEqual([]);
  });
  // A file's related entries are polymorphic: no populate of them is answered, at any depth, on a
  // read or in a write's response, as on a collection type.
  it("refuses a populate of a file's related entries, on a read or a write", async () => {
    const related = {
      featured: { populate: { notes: { populate: { attachment: { populate: "related" } } } } },
    };
    for (const state of [reviewer(), asGuest]) {
      const read = context(state, { query: { populate: related } });
      await front().find(read);
      expect(read.status).toBe(400);
      const write = context(state, {
        query: { populate: related },
        request: { body: { data: { headline: "x" } } },
      });
      await front().update(write);
      expect(write.status).toBe(400);
    }
    expect(calls).toEqual([]);
    await front().find(context(reviewer(), { query: { populate: { featured: true } } }));
    expect(calls).toEqual([`core.find ${FRONT}`]);
    calls.length = 0;
    const custom = context(tokenState("custom"), { query: { populate: related } });
    await front().find(custom);
    expect(custom.status).toBe(400);
    await front().find(context(tokenState("read-only"), { query: { populate: related } }));
    expect(calls).toEqual([`core.find ${FRONT}`]);
  });
  it("leaves an admin role's and an API token's requests, and every delete, to Strapi", async () => {
    const data = { featured: { connect: [{ id: 2, __pivot: { front_id: 9 } }] } };
    for (const state of [asUser(13, "manager"), asToken])
      await front().update(context(state, { request: { body: { data } } }));
    await front().find(context(reviewer()));
    await front().delete(context(reviewer()));
    expect(calls).toEqual([
      `core.update ${FRONT}`,
      `core.update ${FRONT}`,
      `core.find ${FRONT}`,
      `core.delete ${FRONT}`,
    ]);
  });
});
