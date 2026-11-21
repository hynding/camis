import { describe, expect, it } from "vitest";
import {
  callerOf,
  createVerdict,
  refsVerdict,
  relationRefs,
  scopeQuery,
  withoutAssigned,
  type Tables,
  listFilter,
  recordData,
  recordVerdict,
  scopedFilters,
  type Condition,
  type RecordData,
  type TypeRules,
} from "./api-conditions";

const isEditor: Condition = {
  test: (data: RecordData) => data["user.role"] === "editor",
  filter: { kind: "caller", test: (data: RecordData) => data["user.role"] === "editor" },
};
const owned: Condition = {
  test: (data: RecordData) =>
    data["user.id"] !== undefined && data["record.ownerId"] === data["user.id"],
  filter: { kind: "eq", variable: "record.ownerId", value: { kind: "user", variable: "user.id" } },
};
const recent: Condition = {
  test: (data: RecordData) => data["record.seenAt"] === "2026-01-01T00:00:00.000Z",
  filter: null,
};

const rules: TypeRules = {
  own: true,
  defaults: {},
  variables: {
    "record.ownerId": { field: "owner", relation: true },
    "record.seenAt": { field: "seenAt", relation: false },
  },
  open: ["findOne"],
  assign: [],
  admins: [],
  roles: {
    editor: { read: [isEditor], assign: [] },
    member: { read: [owned, isEditor], assign: [] },
    public: { read: [owned], assign: [] },
  },
};
const session = (role: string) => ({ user: { id: 7, documentId: "u7", role: { type: role } } });
const guest = { auth: { strategy: { name: "users-permissions" } } };
const NO_ROWS = { id: { $null: true } };

describe("listFilter", () => {
  it("decides a condition that reads only the caller before the query", () => {
    expect(listFilter(rules, callerOf(rules, session("editor"), "find"))).toBeNull();
    const onlyEditors = { ...rules, roles: { member: { read: [isEditor], assign: [] } } };
    expect(listFilter(onlyEditors, callerOf(onlyEditors, session("member"), "find"))).toEqual(
      NO_ROWS,
    );
  });
  it("reads the rows any of a role's conditions lets through", () => {
    // member is not an editor, so only the ownership branch is left.
    expect(listFilter(rules, callerOf(rules, session("member"), "find"))).toEqual({
      owner: { id: { $eq: 7 } },
    });
  });
  it("matches no row where a guest's condition compares the user", () => {
    expect(listFilter(rules, callerOf(rules, guest, "find"))).toEqual(NO_ROWS);
  });
  it("lists nothing for a read condition that has no filter, should one ever arrive", () => {
    const unfiltered = { ...rules, roles: { member: { read: [recent], assign: [] } } };
    expect(listFilter(unfiltered, callerOf(unfiltered, session("member"), "find"))).toEqual(
      NO_ROWS,
    );
  });
  it("leaves an open action unrestricted", () => {
    expect(callerOf(rules, guest, "findOne").kind).toBe("unrestricted");
  });
});

describe("scopedFilters", () => {
  it("is the scope alone when the client sends no filter, and an $and of both otherwise", () => {
    const scope = { owner: { id: { $eq: 7 } } };
    expect(scopedFilters(undefined, scope)).toBe(scope);
    expect(scopedFilters({}, scope)).toBe(scope);
    expect(scopedFilters({ title: { $eq: "a" } }, scope)).toEqual({
      $and: [{ title: { $eq: "a" } }, scope],
    });
  });
});

describe("recordData and recordVerdict", () => {
  it("reads a date as its ISO string and a missing relation as null", () => {
    expect(
      recordData(rules, { seenAt: new Date("2026-01-01T00:00:00.000Z"), owner: null }),
    ).toEqual({
      "record.ownerId": null,
      "record.seenAt": "2026-01-01T00:00:00.000Z",
    });
  });
  it("denies an entry when any of its rows (versions, locales) fails", () => {
    const caller = callerOf(rules, session("public"), "update");
    const rows = [{ owner: { id: 7 } }, { owner: { id: 8 } }];
    expect(recordVerdict(rules, caller, "read", rows)).toBe("notFound");
    expect(recordVerdict(rules, caller, "read", [rows[0]])).toBe("allow");
  });
});

// Tags reach notes directly, through a parent tag, a repeatable reference component and a
// dynamic zone of references; a member reads its own notes, a guest the shared ones.
const shared: Condition = {
  test: (data: RecordData) => data["record.shared"] === true,
  filter: { kind: "eq", variable: "record.shared", value: { kind: "literal", value: true } },
};
const unshared: Condition = {
  test: (data: RecordData) => data["record.shared"] !== true,
  filter: null,
};
const NOTE = "api::note.note";
const TAG = "api::tag.tag";
const REF = "shared.reference";
const tables: Tables = {
  rules: {
    [NOTE]: {
      own: true,
      defaults: { "record.shared": true },
      variables: {
        "record.ownerId": { field: "owner", relation: true },
        "record.shared": { field: "shared", relation: false },
      },
      open: [],
      assign: ["owner"],
      admins: ["manager"],
      roles: {
        member: { read: [owned], create: [owned], assign: ["owner"] },
        contributor: { create: [unshared], assign: ["owner"] },
        public: { read: [shared], assign: [] },
        reviewer: { read: true, assign: [] },
      },
    },
    [TAG]: {
      own: false,
      defaults: {},
      variables: {},
      open: [],
      assign: [],
      admins: ["manager"],
      roles: {},
    },
  },
  holders: {
    [TAG]: {
      populatable: ["note", "parent", "refs", "blocks"],
      links: {
        note: { relation: NOTE },
        parent: { relation: TAG },
        refs: { component: REF },
        blocks: { zone: [REF] },
      },
    },
    [REF]: { populatable: ["note"], links: { note: { relation: NOTE } } },
  },
};
const member = session("member");
const MINE = { owner: { id: { $eq: 7 } } };
const SHARED = { shared: { $eq: true } };
const token = { auth: { strategy: { name: "api-token" } } };

const scoped = (state: unknown, query: Record<string, unknown>) => {
  const result = scopeQuery(tables, TAG, state, query);
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

describe("scopeQuery: a populate into a conditioned type carries the caller's filter", () => {
  it("expands populate=* to every populatable attribute, scoping the conditioned ones", () => {
    expect(scoped(member, { populate: "*" }).populate).toEqual({
      note: { filters: MINE },
      parent: true,
      refs: true,
      blocks: true,
    });
  });
  it("normalises comma lists, dotted paths and arrays, at any depth", () => {
    expect(scoped(member, { populate: "note,parent.note" }).populate).toEqual({
      note: { filters: MINE },
      parent: { populate: { note: { filters: MINE } } },
    });
    expect(scoped(member, { populate: ["refs.note"] }).populate).toEqual({
      refs: { populate: { note: { filters: MINE } } },
    });
    expect(scoped(member, { populate: { parent: { populate: "*" } } }).populate).toEqual({
      parent: {
        populate: { note: { filters: MINE }, parent: true, refs: true, blocks: true },
      },
    });
  });
  it("keeps the client's own populate filter, under $and with the scope", () => {
    const query = { populate: { note: { filters: { title: { $eq: "x" } }, fields: ["title"] } } };
    expect(scoped(member, query).populate).toEqual({
      note: { filters: { $and: [{ title: { $eq: "x" } }, MINE] }, fields: ["title"] },
    });
  });
  it("scopes a dynamic zone's components through per-component fragments", () => {
    expect(scoped(member, { populate: { blocks: { populate: "*" } } }).populate).toEqual({
      blocks: { on: { [REF]: { populate: { note: { filters: MINE } } } } },
    });
    expect(
      scoped(member, { populate: { blocks: { on: { [REF]: { populate: ["note"] } } } } }).populate,
    ).toEqual({ blocks: { on: { [REF]: { populate: { note: { filters: MINE } } } } } });
  });
  it("gives a guest the public role's filter, and leaves a token's query as it is", () => {
    expect(scoped(guest, { populate: "note" }).populate).toEqual({ note: { filters: SHARED } });
    const query = { populate: "*" };
    expect(scoped(token, query)).toBe(query);
    expect(scoped(session("reviewer"), { populate: "note" }).populate).toEqual({ note: true });
  });
  it("lets a caller-chosen key that names no attribute through untouched, prototype names too", () => {
    expect(scoped(member, { populate: { constructor: true, toString: true } }).populate).toEqual({
      constructor: true,
      toString: true,
    });
  });
});

describe("scopeQuery: filters and sorts through a relation into a conditioned type", () => {
  it("scopes a relation filter, inside $or/$not and through components, so it is no oracle", () => {
    expect(scoped(member, { filters: { note: { title: { $eq: "x" } } } }).filters).toEqual({
      note: { $and: [{ title: { $eq: "x" } }, MINE] },
    });
    expect(
      scoped(member, {
        filters: {
          $or: [{ label: { $eq: "a" } }, { $not: { refs: { note: { title: { $eq: "x" } } } } }],
        },
      }).filters,
    ).toEqual({
      $or: [
        { label: { $eq: "a" } },
        { $not: { refs: { note: { $and: [{ title: { $eq: "x" } }, MINE] } } } },
      ],
    });
    expect(
      scoped(member, { filters: { parent: { note: { title: { $eq: "x" } } } } }).filters,
    ).toEqual({
      parent: { note: { $and: [{ title: { $eq: "x" } }, MINE] } },
    });
  });
  // A sort's join cannot carry a filter: the order of unreadable rows would leak.
  it("refuses a sort through a relation into a conditioned type, at the top or in a populate", () => {
    for (const sort of [
      "note.title:asc",
      ["label", "note.title"],
      [{ note: { title: "asc" } }],
      "parent.note.title",
    ]) {
      const result = scopeQuery(tables, TAG, member, { sort });
      expect(result.ok, JSON.stringify(sort)).toBe(false);
    }
    expect(
      scopeQuery(tables, TAG, member, { populate: { parent: { sort: "note.title" } } }).ok,
    ).toBe(false);
    expect(scopeQuery(tables, TAG, member, { sort: ["label:asc", "parent.label"] }).ok).toBe(true);
    expect(scopeQuery(tables, TAG, session("reviewer"), { sort: "note.title" }).ok).toBe(true);
  });
});

describe("relationRefs and refsVerdict: a write may only link entries the caller may read", () => {
  const refs = (data: Record<string, unknown>, state: unknown = member) => {
    const result = relationRefs(tables, TAG, state, data);
    if (!result.ok) throw new Error(result.message);
    return result.value;
  };
  it("collects every shape that links a conditioned entry: shorthand, connect, set, components, zones", () => {
    expect(refs({ note: "d1" })).toEqual([{ target: NOTE, documentIds: ["d1"], ids: [] }]);
    expect(refs({ note: { connect: [{ documentId: "d2" }, 5], disconnect: ["d9"] } })).toEqual([
      { target: NOTE, documentIds: ["d2"], ids: [5] },
    ]);
    expect(refs({ note: { set: [{ id: 6 }] }, refs: [{ note: ["d3"] }] })).toEqual([
      { target: NOTE, documentIds: ["d3"], ids: [6] },
    ]);
    expect(refs({ blocks: [{ __component: REF, note: "d4" }], label: "x" })).toEqual([
      { target: NOTE, documentIds: ["d4"], ids: [] },
    ]);
    expect(refs({ note: null, parent: "t1" })).toEqual([]);
  });
  it("collects nothing for a caller no condition restricts", () => {
    expect(refs({ note: "d1" }, token)).toEqual([]);
    expect(refs({ note: "d1" }, session("reviewer"))).toEqual([]);
  });
  it("refuses a relation value of a shape it cannot read", () => {
    expect(relationRefs(tables, TAG, member, { note: { connect: [{ weird: 1 }] } }).ok).toBe(false);
    expect(relationRefs(tables, TAG, member, { note: true }).ok).toBe(false);
  });
  it("allows only readable entries, and treats one it cannot find as unreadable", () => {
    const ref = { target: NOTE, documentIds: ["d1"], ids: [5] };
    const mine = [
      { id: 1, documentId: "d1", owner: { id: 7 } },
      { id: 5, documentId: "d5", owner: { id: 7 } },
    ];
    expect(refsVerdict(tables, member, ref, mine)).toBe("allow");
    expect(refsVerdict(tables, member, ref, [mine[0], { ...mine[1], owner: { id: 8 } }])).toBe(
      "forbidden",
    );
    expect(refsVerdict(tables, member, ref, [mine[0]])).toBe("forbidden");
  });
});

describe("createVerdict and assigned fields", () => {
  const note = tables.rules[NOTE]!;
  // Strapi fills an omitted field with its default; the condition must see that value.
  it("evaluates a create condition with the field defaults applied", () => {
    const contributor = callerOf(note, session("contributor"), "create");
    expect(createVerdict(note, contributor, {})).toBe("forbidden");
    expect(createVerdict(note, contributor, { shared: false })).toBe("allow");
  });
  it("refuses a role the rules do not name, prototype names included", () => {
    for (const role of ["stranger", "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const caller = callerOf(note, session(role), "create");
      expect(caller.kind, role).toBe("role");
      expect(createVerdict(note, caller, { title: "x" }), role).toBe("forbidden");
      expect(listFilter(note, caller), role).toEqual(NO_ROWS);
      expect(withoutAssigned(caller, { owner: 1, title: "x" }), role).toEqual({ title: "x" });
    }
  });
});
