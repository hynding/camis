import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, type Model } from "@strapi/database";
import { relationChange, relationRefs, scopeQuery, writePlan, writeShape } from "./api-conditions";
import { CATEGORY, NOTE, REF, TAG, tables } from "./__fixtures__/reach-tables";

// The scoped queries run on Strapi's own query engine over a throwaway sqlite database (Strapi
// resolves the filename as a path, so ":memory:" would be a file in the working directory), so the
// SQL they become is what is tested: its NULLs, its joins, and how a nested where is merged. The
// models are the ones Strapi builds for the fixture's types (a repeatable component is a
// relation through the holder's `_cmps` join table), written out so no Strapi app is booted.

const USER = "plugin::users-permissions.user";
const MEMBER = 7;
const OTHER = 8;

const relation = (target: string) => ({ type: "relation", relation: "manyToOne", target });
const models = [
  {
    uid: USER,
    singularName: "user",
    tableName: "up_users",
    attributes: { id: { type: "increments" }, username: { type: "string" } },
  },
  {
    uid: NOTE,
    singularName: "note",
    tableName: "notes",
    attributes: {
      id: { type: "increments" },
      title: { type: "string" },
      shared: { type: "boolean" },
      owner: relation(USER),
    },
  },
  {
    uid: CATEGORY,
    singularName: "category",
    tableName: "categories",
    attributes: {
      id: { type: "increments" },
      label: { type: "string" },
      notes: { type: "relation", relation: "manyToMany", target: NOTE },
    },
  },
  {
    uid: REF,
    singularName: "reference",
    tableName: "components_shared_references",
    attributes: { id: { type: "increments" }, label: { type: "string" }, note: relation(NOTE) },
  },
  {
    uid: "tags_cmps",
    singularName: "tags_cmps",
    tableName: "tags_cmps",
    attributes: {
      id: { type: "increments" },
      entity_id: { type: "integer" },
      cmp_id: { type: "integer" },
      component_type: { type: "string" },
      field: { type: "string" },
      order: { type: "float" },
    },
  },
  {
    uid: TAG,
    singularName: "tag",
    tableName: "tags",
    attributes: {
      id: { type: "increments" },
      label: { type: "string" },
      note: relation(NOTE),
      parent: relation(TAG),
      refs: {
        type: "relation",
        relation: "oneToMany",
        target: REF,
        joinTable: {
          name: "tags_cmps",
          joinColumn: { name: "entity_id", referencedColumn: "id" },
          inverseJoinColumn: { name: "cmp_id", referencedColumn: "id" },
          on: { field: "refs" },
          orderColumnName: "order",
          orderBy: { order: "asc" },
          pivotColumns: ["entity_id", "cmp_id", "field", "component_type"],
        },
      },
    },
  },
] as unknown as Model[];

let db: Database;
let directory: string;
const ids: Record<string, number> = {};

const create = async (uid: string, data: Record<string, unknown>): Promise<number> => {
  const row = (await db.query(uid).create({ data })) as { id: number };
  return row.id;
};

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "camis-engine-"));
  const quiet = () => undefined;
  db = new Database({
    connection: {
      client: "sqlite",
      connection: { filename: join(directory, "engine.db") },
      useNullAsDefault: true,
    },
    settings: { runMigrations: false, migrations: { dir: directory } },
    logger: { info: quiet, warn: quiet, debug: quiet, error: quiet },
  });
  (globalThis as { strapi?: unknown }).strapi = { db };
  await db.init({ models });
  await db.schema.sync();
  await create(USER, { id: MEMBER, username: "member" });
  await create(USER, { id: OTHER, username: "other" });
  // A note of the member's, one of another user's, one with no owner and no `shared` (both
  // NULL), and another user's shared note.
  ids.mine = await create(NOTE, { title: "mine", shared: false, owner: MEMBER });
  ids.theirs = await create(NOTE, { title: "secret-theirs", shared: false, owner: OTHER });
  ids.orphan = await create(NOTE, { title: "secret-orphan" });
  ids.open = await create(NOTE, { title: "open", shared: true, owner: OTHER });
  ids.tagMine = await create(TAG, { label: "t-mine", note: ids.mine });
  ids.tagTheirs = await create(TAG, { label: "t-theirs", note: ids.theirs });
  await create(TAG, { label: "t-orphan", note: ids.orphan });
  await create(TAG, { label: "t-open", note: ids.open });
  ids.tagNone = await create(TAG, { label: "t-none" });
  await create(TAG, { label: "t-child-of-theirs", note: ids.mine, parent: ids.tagTheirs });
  await create(TAG, { label: "t-child-of-mine", note: ids.mine, parent: ids.tagMine });
  const pivot = { field: "refs", component_type: REF };
  const references = [
    await create(REF, { label: "r-mine", note: ids.mine }),
    await create(REF, { label: "r-theirs", note: ids.theirs }),
    await create(REF, { label: "r-orphan", note: ids.orphan }),
  ];
  await create(TAG, { label: "t-refs", refs: references.map((id) => ({ id, __pivot: pivot })) });
  // A tag beside t-none and t-theirs for each path: a reference with no note and one to another
  // user's private note; a child of the tag with no note.
  const bare = await create(REF, { label: "r-none" });
  await create(TAG, { label: "t-ref-none", refs: [{ id: bare, __pivot: pivot }] });
  const hidden = await create(REF, { label: "r-theirs-2", note: ids.theirs });
  await create(TAG, { label: "t-ref-theirs", refs: [{ id: hidden, __pivot: pivot }] });
  await create(TAG, { label: "t-child-of-none", note: ids.mine, parent: ids.tagNone });
});

afterAll(async () => {
  await db.destroy();
  delete (globalThis as { strapi?: unknown }).strapi;
  rmSync(directory, { recursive: true, force: true });
});

const member = { user: { id: MEMBER, documentId: "member", role: { type: "member" } } };
const guest = { auth: { strategy: { name: "users-permissions" } } };
const as = (role: string) => ({ user: { id: MEMBER, documentId: "member", role: { type: role } } });

/** A sanitized query's REST parameters as the query engine's (Strapi's convertQueryParams). */
const engineParams = (query: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (query.filters !== undefined) out.where = query.filters;
  if (query.fields !== undefined) out.select = query.fields;
  if (query.count !== undefined) out.count = query.count;
  const nested = (entries: unknown) =>
    Object.fromEntries(
      Object.entries(entries as Record<string, unknown>).map(([key, entry]) => [
        key,
        typeof entry === "object" && entry !== null
          ? engineParams(entry as Record<string, unknown>)
          : entry,
      ]),
    );
  if (query.populate !== undefined) out.populate = nested(query.populate);
  if (query.on !== undefined) out.on = nested(query.on);
  return out;
};

/** What a list of tags answers the caller: "refused" (a 400), or each tag as the engine reads it. */
const answer = async (state: unknown, query: Record<string, unknown>): Promise<unknown> => {
  const scoped = scopeQuery(tables, TAG, state, query);
  if (!scoped.ok) return "refused";
  const rows = await db
    .query(TAG)
    .findMany({ select: ["id", "label"], ...engineParams(scoped.value), orderBy: { id: "asc" } });
  return JSON.parse(
    JSON.stringify(rows, (key, value: unknown) => (key === "id" ? undefined : value)),
  );
};

const labels = async (state: unknown, query: Record<string, unknown>): Promise<unknown> => {
  const rows = await answer(state, query);
  return Array.isArray(rows) ? rows.map((row: { label: string }) => row.label) : rows;
};

/** A query is no oracle when a right guess at an unreadable value answers as a wrong one does. */
const sameForAnyGuess = async (
  state: unknown,
  query: (guess: string) => Record<string, unknown>,
) => {
  const right = [
    await answer(state, query("secret-theirs")),
    await answer(state, query("secret-orphan")),
  ];
  const wrong = await answer(state, query("wrong"));
  expect(right[0]).toEqual(wrong);
  expect(right[1]).toEqual(wrong);
};

describe("scoped queries on Strapi's query engine", () => {
  it("narrows a relation filter to readable rows, NULL owners included", async () => {
    expect(await labels(member, { filters: { note: { title: { $eq: "mine" } } } })).toEqual([
      "t-mine",
      "t-child-of-theirs",
      "t-child-of-mine",
      "t-child-of-none",
    ]);
    await sameForAnyGuess(member, (guess) => ({ filters: { note: { title: { $eq: guess } } } }));
    expect(await labels(member, { filters: { note: { shared: { $null: true } } } })).toEqual([]);
    expect(await labels(guest, { filters: { note: { title: { $eq: "open" } } } })).toEqual([
      "t-open",
    ]);
    await sameForAnyGuess(guest, (guess) => ({ filters: { note: { title: { $eq: guess } } } }));
  });

  it("keeps two relation filters at one level, each with its own scope", async () => {
    const both = (parentTitle: string) => ({
      filters: {
        note: { title: { $eq: "mine" } },
        parent: { note: { title: { $eq: parentTitle } } },
      },
    });
    expect(await labels(member, both("mine"))).toEqual(["t-child-of-mine"]);
    expect(await labels(member, both("secret-theirs"))).toEqual([]);
    await sameForAnyGuess(member, both);
  });

  // SQL's NOT of an unknown is unknown: a row whose scope is NULL would drop out of a right
  // guess and stay in a wrong one, so a $not around a scoped relation is refused.
  it("refuses a $not around a relation filter into a conditioned type", async () => {
    const shapes = [
      (guess: string) => ({ filters: { $not: { note: { title: { $eq: guess } } } } }),
      (guess: string) => ({ filters: { $not: { refs: { note: { title: { $eq: guess } } } } } }),
      (guess: string) => ({ filters: { $not: { parent: { note: { title: { $eq: guess } } } } } }),
      (guess: string) => ({
        populate: { parent: { filters: { $not: { note: { title: { $eq: guess } } } } } },
      }),
    ];
    for (const shape of shapes) {
      expect(await answer(member, shape("wrong"))).toBe("refused");
      await sameForAnyGuess(member, shape);
    }
    expect(await answer(member, { filters: { $not: { note: { id: { $null: true } } } } })).toBe(
      "refused",
    );
    expect(await labels(member, { filters: { $not: { label: { $eq: "t-mine" } } } })).toHaveLength(
      10,
    );
    expect(
      await labels(member, { filters: { note: { $not: { title: { $eq: "mine" } } } } }),
    ).toEqual([]);
  });

  it("scopes a component's populate filters and refuses a sort through its relation", async () => {
    const refs = (guess: string) => ({
      filters: { label: { $eq: "t-refs" } },
      populate: { refs: { filters: { note: { title: { $eq: guess } } }, populate: ["note"] } },
    });
    await sameForAnyGuess(member, refs);
    expect(await answer(member, refs("mine"))).toEqual([
      { label: "t-refs", refs: [{ label: "r-mine", note: { title: "mine", shared: false } }] },
    ]);
    expect(
      await answer(member, {
        filters: { label: { $eq: "t-refs" } },
        populate: { refs: { sort: "note.title:asc" } },
      }),
    ).toBe("refused");
  });

  it("narrows a populate's own filters to readable rows", async () => {
    await sameForAnyGuess(member, (guess) => ({
      filters: { label: { $eq: "t-orphan" } },
      populate: { note: { filters: { title: { $eq: guess } } } },
    }));
    await sameForAnyGuess(member, (guess) => ({
      populate: { parent: { filters: { note: { title: { $eq: guess } } } } },
    }));
  });

  // A relation's own operator applies to the related row's id, under the scope; "has none" would
  // count an unreadable entry as none, so it is refused.
  it("reads an operator on the relation itself as one on the related id", async () => {
    expect(await labels(member, { filters: { note: { $in: [ids.mine, ids.theirs] } } })).toEqual([
      "t-mine",
      "t-child-of-theirs",
      "t-child-of-mine",
      "t-child-of-none",
    ]);
    expect(await labels(member, { filters: { note: { $eq: ids.theirs } } })).toEqual([]);
    expect(await labels(member, { filters: { note: ids.mine } })).toHaveLength(4);
    expect(await labels(member, { filters: { note: { $notNull: true } } })).toEqual([
      "t-mine",
      "t-child-of-theirs",
      "t-child-of-mine",
      "t-child-of-none",
    ]);
    expect(await answer(member, { filters: { note: { $null: true } } })).toBe("refused");
    expect(await answer(member, { filters: { note: { $notNull: false } } })).toBe("refused");
    expect(await answer(member, { filters: { note: { $in: [1], title: "x" } } })).toBe("refused");
    // Over HTTP the value is a string, read as Strapi's parseType reads a boolean.
    expect(await labels(member, { filters: { note: { $null: "false" } } })).toEqual([
      "t-mine",
      "t-child-of-theirs",
      "t-child-of-mine",
      "t-child-of-none",
    ]);
    for (const note of [{ $notNull: "false" }, { $null: "1" }, { $notNull: "f" }, { $null: "yes" }])
      expect(await answer(member, { filters: { note } }), JSON.stringify(note)).toBe("refused");
    expect(await labels(member, { filters: { parent: { $null: true } } })).toHaveLength(8);
  });

  // Strapi LEFT JOINs a filtered relation: a tag with no note joins an all-NULL row, which a
  // client's `$null` matches, and so would a scope a NULL satisfies (no read: a filter no row
  // passes; a null-literal condition: owner IS NULL). Each shape here is one an all-NULL row may
  // satisfy; with no entry and with an entry the caller cannot read, it must answer the same.
  it("answers alike for no linked entry and an unreadable one, for every NULL-satisfied shape", async () => {
    const shapes: Record<string, unknown>[] = [
      { id: { $null: true } },
      { title: { $null: true } },
      { title: { $null: "true" } },
      { id: { $notNull: false } },
      { title: { $ne: "x" } },
      { title: { $notIn: ["x"] } },
      { title: { $notContains: "x" } },
      { $not: { title: { $notNull: true } } },
      { $not: { title: { $eq: "x" } } },
      { $or: [{ title: { $null: true } }, { title: { $eq: "x" } }] },
      { owner: { id: { $null: true } } },
    ];
    const roles = { contributor: as("contributor"), drafter: as("drafter"), guest, member };
    const paths: [string, (shape: unknown) => Record<string, unknown>, string, string][] = [
      ["relation", (note) => ({ filters: { note } }), "t-none", "t-theirs"],
      ["component", (note) => ({ filters: { refs: { note } } }), "t-ref-none", "t-ref-theirs"],
      [
        "parent",
        (note) => ({ filters: { parent: { note } } }),
        "t-child-of-none",
        "t-child-of-theirs",
      ],
    ];
    for (const [roleName, state] of Object.entries(roles)) {
      for (const shape of shapes) {
        for (const [path, query, none, hidden] of paths) {
          const found = await labels(state, query(shape));
          const what = `${roleName} ${path} ${JSON.stringify(shape)}: ${JSON.stringify(found)}`;
          expect(Array.isArray(found), what).toBe(true);
          expect((found as string[]).includes(none), what).toBe(
            (found as string[]).includes(hidden),
          );
        }
        const populated = (await answer(state, {
          filters: { label: { $in: ["t-child-of-none", "t-child-of-theirs"] } },
          populate: { parent: { filters: { note: shape } } },
        })) as { label: string; parent: unknown }[];
        const what = `${roleName} populate ${JSON.stringify(shape)}: ${JSON.stringify(populated)}`;
        expect(
          populated.map((row) => row.parent === null),
          what,
        ).toEqual([true, true]);
      }
    }
  });
});

// Strapi's entity manager builds a relation's join row as { <owner>_id, <target>_id: item.id,
// ...item.__pivot }: the item's __pivot overrides the id the checks decided on. The same holds for
// a media item's row in files_related_mph (file_id, related_id, related_type).
describe("an item's __pivot on Strapi's own entity manager", () => {
  it("links the entry __pivot names, not the id checked, so camis refuses the item", async () => {
    const note = { connect: [{ id: ids.mine, __pivot: { note_id: ids.theirs } }] };
    const tag = await create(TAG, { label: "t-pivot", note });
    const row = (await db.query(TAG).findOne({ where: { id: tag }, populate: { note: true } })) as {
      note: { id: number } | null;
    };
    expect(row.note?.id).toBe(ids.theirs);
    expect(relationRefs(tables, TAG, member, { note })).toEqual({
      ok: false,
      message: "Invalid relation value for note",
    });
    expect(writeShape(tables, TAG, { label: "t", note }).ok).toBe(false);
  });
});

// The change camis plans for a relation value is the change Strapi makes: each row id form camis
// accepts is written by Strapi's own entity manager (toAssocs, then the join table writes) and the
// links it leaves are those relationChange predicts, on a to-many and on a to-one relation. The
// documentId forms reach the entity manager as these same forms: the document service's
// mapRelation maps each item's documentId to row ids and keeps the shape (a shorthand in a set).
describe("relationChange against Strapi's own entity manager", () => {
  type Ids = number[];
  const linksOf = async (uid: string, id: number, attribute: string): Promise<Ids> => {
    const row = (await db
      .query(uid)
      .findOne({ where: { id }, populate: { [attribute]: true } })) as Record<
      string,
      unknown
    > | null;
    const value = row?.[attribute];
    const items = Array.isArray(value)
      ? value
      : value === null || value === undefined
        ? []
        : [value];
    return items.map((item) => (item as { id: number }).id).sort((a, b) => a - b);
  };
  const predicted = (value: unknown, initial: Ids, toOne: boolean): Ids => {
    const change = relationChange(value, "relation");
    if (change === null) throw new Error(`refused ${JSON.stringify(value)}`);
    const connect = change.connect.ids;
    const disconnect = change.disconnect.ids;
    if (change.mode === "replace" || (toOne && connect.length > 0)) return [...connect].sort();
    return [...new Set([...initial, ...connect])].filter((id) => !disconnect.includes(id)).sort();
  };
  const toMany = (): unknown[] => [
    ids.theirs,
    String(ids.theirs),
    [ids.theirs, ids.orphan],
    [],
    null,
    { id: ids.theirs },
    { connect: [ids.theirs] },
    { connect: ids.theirs },
    { disconnect: [ids.mine] },
    { connect: [ids.theirs], disconnect: [ids.mine] },
    { connect: [ids.theirs], options: { strict: false } },
    { options: { strict: true } },
    { set: [ids.theirs] },
    { set: { id: ids.theirs } },
    { set: ids.theirs },
    { set: String(ids.theirs) },
    { set: [] },
    { set: null },
    { set: null, connect: [ids.theirs] },
    { set: [ids.theirs], connect: null, disconnect: null },
  ];
  it("on a to-many relation", async () => {
    for (const value of toMany()) {
      const initial = [ids.mine!, ids.open!].sort();
      const category = await create(CATEGORY, { label: "c", notes: initial });
      await db.query(CATEGORY).update({ where: { id: category }, data: { notes: value } });
      const after = await linksOf(CATEGORY, category, "notes");
      expect(after, JSON.stringify(value)).toEqual(predicted(value, initial, false));
      // What a replacement keeps is what the write plan decides the dropped entries on.
      const plan = writePlan(tables, CATEGORY, as("reviewer"), { notes: value });
      const change = relationChange(value, "relation")!;
      expect(plan.ok && plan.value.replaced.map((r) => r.kept), JSON.stringify(value)).toEqual(
        change.mode === "replace" ? [change.connect] : [],
      );
    }
  });
  it("on a to-one relation", async () => {
    for (const value of [
      ids.theirs,
      null,
      [ids.theirs],
      { connect: [ids.theirs] },
      { disconnect: [ids.mine] },
      { set: ids.theirs },
      { set: [ids.theirs] },
      { set: null },
      { set: null, connect: [ids.theirs] },
    ]) {
      const tag = await create(TAG, { label: "one", note: ids.mine });
      await db.query(TAG).update({ where: { id: tag }, data: { note: value } });
      expect(await linksOf(TAG, tag, "note"), JSON.stringify(value)).toEqual(
        predicted(value, [ids.mine!], true),
      );
    }
  });
});
