import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { strapiAdapter } from "../generate";
import { ownershipBundle } from "../__fixtures__/ownership";

// The generated upload extension and entry controllers run against a small fake of the parts of
// Strapi they use: the upload plugin's content API controller (which stores whatever it is
// given, as the real one does), its file table with each file's related entries, and the query
// engine. A refusal must come before the fake stores, replaces or deletes anything.

const NOTE = "api::note.note";
const TAG = "api::tag.tag";
const FILE = "plugin::upload.file";
const REF = "shared.reference";

type Row = Record<string, unknown> & { id: number };
type Filter = Record<string, unknown>;

const matches = (row: Row, where: Filter): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === "$or") return (cond as Filter[]).some((f) => matches(row, f));
    if (typeof cond === "object" && cond !== null && "$in" in cond)
      return (cond.$in as unknown[]).includes(row[key]);
    return row[key] === cond;
  });

const tables: Record<string, Row[]> = {};
let stored: string[] = [];
const seed = (): void => {
  tables[NOTE] = [
    { id: 1, documentId: "mine", title: "mine", owner: { id: 10 } },
    { id: 2, documentId: "theirs", title: "theirs", owner: { id: 11 } },
    { id: 3, documentId: "reviewed", title: "reviewed", owner: { id: 12 } },
  ];
  tables[TAG] = [{ id: 1, documentId: "t1", label: "t1" }];
  tables[FILE] = [
    { id: 1, camisUploader: 10, related: [] },
    { id: 2, camisUploader: 11, related: [{ __type: NOTE, id: 2 }] },
    { id: 3, camisUploader: 11, related: [] },
    { id: 4, camisUploader: 11, related: [{ __type: NOTE, id: 1 }] },
    { id: 5, camisUploader: 10, related: [{ __type: REF, id: 1 }] },
    { id: 6, camisUploader: 10, related: [{ __type: NOTE, id: 2 }] },
  ];
  stored = [];
};

const strapi = {
  db: {
    query: (uid: string) => ({
      findMany: async (params: { where: Filter }) =>
        (tables[uid] ?? []).filter((r) => matches(r, params.where)),
      updateMany: async (params: { where: Filter; data: Record<string, unknown> }) => {
        for (const row of (tables[uid] ?? []).filter((r) => matches(r, params.where)))
          Object.assign(row, params.data);
      },
    }),
  },
  service: (uid: string) => ({
    create: async (params: { data: Record<string, unknown> }) => {
      const row = { ...params.data, id: tables[uid]!.length + 1, documentId: `new-${uid}` };
      tables[uid]!.push(row);
      return row;
    },
    update: async (documentId: string, params: { data: Record<string, unknown> }) => {
      const row = tables[uid]!.find((r) => r.documentId === documentId);
      return row === undefined ? null : Object.assign(row, params.data);
    },
  }),
};

interface Context {
  params: { id?: string };
  query: Record<string, unknown>;
  state: unknown;
  request: { body?: unknown; files?: { files?: unknown } };
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
    notFound: () => {
      ctx.status = 404;
    },
    forbidden: () => {
      ctx.status = 403;
    },
    badRequest: () => {
      ctx.status = 400;
    },
    ...extra,
  };
  return ctx;
};

/** The upload plugin's content API controller: it stores, replaces and deletes as asked. */
const uploadController = () => ({
  async find(ctx: Context) {
    ctx.body = tables[FILE];
  },
  async destroy(ctx: Context) {
    stored.push(`destroy ${ctx.params.id}`);
    tables[FILE] = tables[FILE]!.filter((f) => f.id !== Number(ctx.params.id));
    ctx.body = { id: Number(ctx.params.id) };
  },
  async updateFileInfo(ctx: Context) {
    stored.push(`info ${String(ctx.query.id)}`);
  },
  async replaceFile(ctx: Context) {
    stored.push(`replace ${String(ctx.query.id)}`);
  },
  async uploadFiles(ctx: Context) {
    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const files = ctx.request.files?.files;
    const created = (Array.isArray(files) ? files : [files]).map(() => {
      const related =
        body.ref && body.refId && body.field ? [{ __type: body.ref, id: Number(body.refId) }] : [];
      const row: Row = { id: tables[FILE]!.length + 10, camisUploader: null, related };
      tables[FILE]!.push(row);
      stored.push(`upload ${row.id}`);
      return { id: row.id };
    });
    ctx.body = created;
    ctx.status = 201;
  },
  // Strapi's own dispatch, through `this`, as in Strapi 5.48.
  async upload(this: Record<string, (ctx: Context) => Promise<void>>, ctx: Context) {
    const files = ctx.request.files?.files;
    if (files === undefined) {
      if (ctx.query.id) return this.updateFileInfo!(ctx);
      throw new Error("Files are empty");
    }
    await (ctx.query.id ? this.replaceFile! : this.uploadFiles!)(ctx);
  },
});

/** Strapi 5's createCoreController: the core's methods under the given ones. */
const coreController = () => ({
  validateQuery: async () => {},
  sanitizeQuery: async (ctx: Context) => ({ ...ctx.query }),
  validateInput: async () => {},
  sanitizeInput: async (data: Record<string, unknown>) => ({ ...data }),
  sanitizeOutput: async (data: unknown) => data,
  transformResponse: (data: unknown) => ({ data }),
});
const createCoreController = (factory: (p: { strapi: typeof strapi }) => object) => {
  const base = coreController();
  const own = factory({ strapi }) as Record<string, unknown>;
  Object.setPrototypeOf(own, base);
  return own as Record<"create" | "update", (ctx: Context) => Promise<unknown>>;
};

interface Plugin {
  contentTypes: { file: { schema: { attributes: Record<string, unknown> } } };
  controllers: Record<string, unknown>;
}
let dir: string;
let plugin: Plugin;
let upload: ReturnType<typeof uploadController>;
const controllers: Record<
  string,
  Record<"create" | "update", (ctx: Context) => Promise<unknown>>
> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "camis-upload-"));
  const result = strapiAdapter.generate(ownershipBundle, { projectName: "notes" });
  for (const f of result.files.filter(
    (f) => f.path.startsWith("src/permissions/") || f.path.startsWith("src/extensions/upload/"),
  )) {
    await mkdir(join(dir, dirname(f.path)), { recursive: true });
    await writeFile(join(dir, f.path), f.content);
  }
  const extension = await import(
    pathToFileURL(join(dir, "src/extensions/upload/strapi-server.ts")).href
  );
  plugin = extension.default({
    contentTypes: { file: { schema: { attributes: {} } } },
    controllers: { "content-api": uploadController },
  });
  const factory = plugin.controllers["content-api"] as (p: {
    strapi: typeof strapi;
  }) => ReturnType<typeof uploadController>;
  upload = factory({ strapi });
  const { TABLES } = await import(
    pathToFileURL(join(dir, "src/permissions/api-conditions.ts")).href
  );
  const { enforcedController } = await import(
    pathToFileURL(join(dir, "src/permissions/api-controller.ts")).href
  );
  for (const uid of [NOTE, TAG])
    controllers[uid] = createCoreController(({ strapi: s }) => enforcedController(s, uid, TABLES));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
beforeEach(seed);

const user = (id: number, role: string) => ({
  auth: { strategy: { name: "users-permissions" } },
  user: { id, documentId: `user-${id}`, role: { type: role } },
});
const alice = () => user(10, "member");
const token = { auth: { strategy: { name: "api-token" } } };
const aFile = { files: { originalFilename: "a.txt", size: 1 } };

const post = async (state: unknown, body: unknown, query: Record<string, unknown> = {}) => {
  const ctx = context(state, { query, request: { body, files: aFile } });
  await upload.upload(ctx);
  return ctx;
};

describe("the upload extension", () => {
  it("records each file's uploader in a private attribute no client can read or set", () => {
    expect(plugin.contentTypes.file.schema.attributes.camisUploader).toEqual({
      type: "integer",
      private: true,
      configurable: false,
    });
  });
});

describe("POST /api/upload with ref, refId and field", () => {
  const to = (refId: unknown, extra: Record<string, unknown> = {}) => ({
    ref: NOTE,
    refId,
    field: "attachment",
    ...extra,
  });
  it("attaches a new file to an entry the caller may update, and records the uploader", async () => {
    const ctx = await post(alice(), to("1"));
    expect(ctx.status).toBe(201);
    const [created] = ctx.body as { id: number }[];
    expect(tables[FILE]!.find((f) => f.id === created!.id)).toMatchObject({
      camisUploader: 10,
      related: [{ __type: NOTE, id: 1 }],
    });
  });
  it("is 403 for another's entry and for one that does not exist, and stores nothing", async () => {
    for (const refId of ["2", "99", 2]) {
      const ctx = await post(alice(), to(refId));
      expect(ctx.status, String(refId)).toBe(403);
    }
    expect(stored).toEqual([]);
  });
  it("is 403 for a component's or plugin's uid, and a non-media or nested field, storing nothing", async () => {
    for (const body of [
      { ref: REF, refId: "1", field: "image" },
      { ref: "plugin::users-permissions.user", refId: "10", field: "avatar" },
      { ref: TAG, refId: "1", field: "refs" },
      { ref: TAG, refId: "1", field: "refs.image" },
      to("1", { field: "title" }),
    ]) {
      const ctx = await post(alice(), body);
      expect(ctx.status, JSON.stringify(body)).toBe(403);
    }
    expect(stored).toEqual([]);
  });
  it("is 400 for a documentId refId, a repeated field, a partial triple or another body field, storing nothing", async () => {
    for (const body of [
      to("theirs"),
      to(["1", "2"]),
      { ref: NOTE, refId: "1" },
      to("1", { path: "../x" }),
      to("1", { folder: "1" }),
      { source: "x" },
    ]) {
      const ctx = await post(alice(), body);
      expect(ctx.status, JSON.stringify(body)).toBe(400);
    }
    expect(stored).toEqual([]);
  });
  it("leaves an API token's upload to Strapi", async () => {
    const ctx = await post(token, to("2"));
    expect(ctx.status).toBe(201);
  });
  it("refuses a session whose role was not loaded", async () => {
    const ctx = await post({ user: { id: 10 } }, {});
    expect(ctx.status).toBe(403);
    expect(stored).toEqual([]);
  });
});

describe("POST /api/upload with no ref", () => {
  it("stores an unattached file owned by its uploader", async () => {
    const ctx = await post(alice(), { fileInfo: '{"name":"a"}' });
    expect(ctx.status).toBe(201);
    const [created] = ctx.body as { id: number }[];
    expect(tables[FILE]!.find((f) => f.id === created!.id)).toMatchObject({
      camisUploader: 10,
      related: [],
    });
  });
});

describe("POST /api/upload?id= (replace, or update a file's info) and DELETE /api/upload/files/:id", () => {
  const replace = (id: string, files: unknown) =>
    upload.upload(context(alice(), { query: { id }, request: { body: {}, files } as never }));
  const destroy = async (id: string) => {
    const ctx = context(alice(), { params: { id } });
    await upload.destroy(ctx);
    return ctx;
  };
  it("is 403 for a file on another's entry or another's unattached file, changing nothing", async () => {
    for (const id of ["2", "3", "5", "99"]) {
      const withFile = context(alice(), { query: { id }, request: { body: {}, files: aFile } });
      await upload.upload(withFile);
      expect(withFile.status, `replace ${id}`).toBe(403);
      const info = context(alice(), { query: { id }, request: { body: {} } });
      await upload.upload(info);
      expect(info.status, `info ${id}`).toBe(403);
      expect((await destroy(id)).status, `destroy ${id}`).toBe(403);
    }
    expect(stored).toEqual([]);
    expect(tables[FILE]!.map((f) => f.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("allows the caller's own unattached file and a file on an entry it may update", async () => {
    await replace("1", aFile);
    await replace("4", aFile);
    await replace("4", undefined);
    expect((await destroy("1")).status).toBeUndefined();
    expect(stored).toEqual(["replace 1", "replace 4", "info 4", "destroy 1"]);
  });
  it("is 400 for a malformed id or a ref beside it", async () => {
    for (const ctx of [
      context(alice(), { query: { id: "x" }, request: { body: {}, files: aFile } }),
      context(alice(), {
        query: { id: "1" },
        request: { body: { ref: NOTE, refId: "1", field: "attachment" }, files: aFile },
      }),
    ]) {
      await upload.upload(ctx);
      expect(ctx.status).toBe(400);
    }
    expect((await destroy("1x")).status).toBe(400);
    expect(stored).toEqual([]);
  });
});

describe("attaching a stored file through an entry's media field", () => {
  const write = async (
    uid: string,
    data: Record<string, unknown>,
    id?: string,
  ): Promise<Context> => {
    const ctx = context(alice(), {
      ...(id === undefined ? {} : { params: { id } }),
      request: { body: { data } },
    });
    await (id === undefined ? controllers[uid]!.create(ctx) : controllers[uid]!.update(ctx));
    return ctx;
  };
  it("is 403 for another's unattached file or one on an entry the caller cannot read", async () => {
    for (const attachment of [3, 2, { id: 3 }, [1, 3], { connect: [2] }]) {
      expect((await write(NOTE, { title: "x", attachment })).status).toBe(403);
      expect((await write(NOTE, { attachment }, "mine")).status).toBe(403);
    }
    expect((await write(TAG, { label: "x", refs: [{ image: 3 }] })).status).toBe(403);
    expect(tables[NOTE]!.length).toBe(3);
    expect(tables[TAG]!.length).toBe(1);
    expect(tables[NOTE]![0]!.attachment).toBeUndefined();
  });
  it("is 400 for a media value it cannot read as a row id", async () => {
    expect((await write(NOTE, { title: "x", attachment: "abc" })).status).toBe(400);
    expect((await write(NOTE, { attachment: { documentId: "x" } }, "mine")).status).toBe(400);
  });
  it("allows the caller's own upload and a file on an entry it may update", async () => {
    expect((await write(NOTE, { title: "x", attachment: 1 })).status).toBe(201);
    expect((await write(NOTE, { attachment: 4 }, "mine")).status).toBeUndefined();
    expect((await write(TAG, { label: "x", refs: [{ image: 1 }] })).status).toBe(201);
  });
  // A reviewer reads every note but updates only its own: reading bob's note is no claim on its file.
  it("is 403 for a file only on an entry the caller may read, not update", async () => {
    const ctx = context(user(12, "reviewer"), {
      params: { id: "reviewed" },
      request: { body: { data: { attachment: 2 } } },
    });
    await controllers[NOTE]!.update(ctx);
    expect(ctx.status).toBe(403);
    expect(tables[NOTE]![2]!.attachment).toBeUndefined();
  });
  // Strapi's database layer spreads an item's __pivot into the join row after the ids it checked.
  it("is 400 for __pivot or any other unknown key, in a media or relation item, a component or the data", async () => {
    for (const [uid, data, id] of [
      [NOTE, { attachment: { connect: [{ id: 1, __pivot: { file_id: 2 } }] } }, "mine"],
      [NOTE, { title: "x", attachment: { set: [{ id: 1, __pivot: { related_id: 2 } }] } }],
      [NOTE, { attachment: { id: 1, __pivot: {} } }, "mine"],
      [TAG, { label: "x", note: { connect: [{ id: 1, __pivot: { note_id: 2 } }] } }],
      [TAG, { label: "x", note: { id: 1, __pivot: { note_id: 2 } } }],
      [TAG, { label: "x", refs: [{ note: 1, __pivot: { entity_id: 9 } }] }],
      [NOTE, { title: "x", publishedAt: "2026-01-01" }],
      [NOTE, { documentId: "theirs", title: "x" }, "mine"],
      [NOTE, { title: "x", createdBy: 1 }],
    ] as [string, Record<string, unknown>, string?][]) {
      const ctx = await write(uid, data, id);
      expect(ctx.status, JSON.stringify(data)).toBe(400);
    }
    expect(tables[NOTE]!.length).toBe(3);
    expect(tables[TAG]!.length).toBe(1);
    expect(tables[NOTE]![0]).toEqual({
      id: 1,
      documentId: "mine",
      title: "mine",
      owner: { id: 10 },
    });
  });
});

describe("the uploader keeps its file", () => {
  // Whoever linked alice's file to bob's note cannot take the file from her.
  it("replaces and deletes its own file wherever it is attached", async () => {
    const replace = context(alice(), { query: { id: "6" }, request: { body: {}, files: aFile } });
    await upload.upload(replace);
    expect(replace.status).toBeUndefined();
    const destroy = context(alice(), { params: { id: "6" } });
    await upload.destroy(destroy);
    expect(destroy.status).toBeUndefined();
    expect(stored).toEqual(["replace 6", "destroy 6"]);
  });
});
