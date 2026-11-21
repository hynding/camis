import { describe, expect, it } from "vitest";
import {
  callerOf,
  createVerdict,
  currentLinksQuery,
  droppedLinks,
  holdersQuery,
  holdersVerdict,
  reachState,
  refsVerdict,
  writePlan,
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
import { CATEGORY, NOTE, REF, TAG, owned, tables } from "./__fixtures__/reach-tables";

const isEditor: Condition = {
  test: (data: RecordData) => data["user.role"] === "editor",
  filter: { kind: "caller", test: (data: RecordData) => data["user.role"] === "editor" },
};
const recent: Condition = {
  test: (data: RecordData) => data["record.seenAt"] === "2026-01-01T00:00:00.000Z",
  filter: null,
};

const rules: TypeRules = {
  own: true,
  defaults: {},
  relations: {},
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
/** A filter no row satisfies, not even a LEFT JOIN's all-NULL row. */
const NO_ROWS = { $and: [{ id: { $null: true } }, { id: { $notNull: true } }] };
/** Beside a scope on a joined relation: the scope must meet a real row, not an all-NULL one. */
const ENTRY = { id: { $notNull: true } };

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
  // Each relation filter is its own item of an $and at its level: Strapi merges a nested
  // relation's where into its parent with Object.assign, so two `$and`s side by side would
  // overwrite each other. The scope stays with the client's filter on that same relation, whose
  // join it must share.
  it("scopes a relation filter, inside $or and through components, so it is no oracle", () => {
    const titled = (title: string) => ({ $and: [{ title: { $eq: title } }, ENTRY, MINE] });
    expect(scoped(member, { filters: { note: { title: { $eq: "x" } } } }).filters).toEqual({
      $and: [{ note: titled("x") }],
    });
    expect(
      scoped(member, {
        filters: { $or: [{ label: { $eq: "a" } }, { refs: { note: { title: { $eq: "x" } } } }] },
      }).filters,
    ).toEqual({
      $or: [{ label: { $eq: "a" } }, { $and: [{ refs: { $and: [{ note: titled("x") }] } }] }],
    });
    expect(
      scoped(member, { filters: { parent: { note: { title: { $eq: "x" } } } } }).filters,
    ).toEqual({ $and: [{ parent: { $and: [{ note: titled("x") }] } }] });
  });
  // SQL's NOT of an unknown is unknown: a row whose scope reads a NULL (an entry with no owner)
  // drops out under a right guess and stays under a wrong one.
  it("refuses a $not whose subtree crosses a relation into a conditioned type, at any depth", () => {
    for (const filters of [
      { $not: { note: { title: { $eq: "x" } } } },
      { $not: { note: { id: { $notNull: true } } } },
      { $or: [{ label: { $eq: "a" } }, { $not: { refs: { note: { title: { $eq: "x" } } } } }] },
      { $not: { $and: [{ parent: { note: { title: { $eq: "x" } } } }] } },
      { parent: { $not: { note: { title: { $eq: "x" } } } } },
    ]) {
      expect(scopeQuery(tables, TAG, member, { filters }).ok, JSON.stringify(filters)).toBe(false);
      const populate = { parent: { filters } };
      expect(scopeQuery(tables, TAG, member, { populate }).ok, JSON.stringify(populate)).toBe(
        false,
      );
    }
    // Inside the relation the scope stays outside the client's $not, so the negation is safe.
    expect(
      scoped(member, { filters: { note: { $not: { title: { $eq: "x" } } } } }).filters,
    ).toEqual({ $and: [{ note: { $and: [{ $not: { title: { $eq: "x" } } }, ENTRY, MINE] } }] });
    expect(scoped(member, { filters: { $not: { label: { $eq: "a" } } } }).filters).toEqual({
      $not: { label: { $eq: "a" } },
    });
    expect(
      scoped(member, { filters: { $not: { parent: { label: { $eq: "a" } } } } }).filters,
    ).toEqual({ $not: { $and: [{ parent: { label: { $eq: "a" } } }] } });
    expect(
      scopeQuery(tables, TAG, session("reviewer"), { filters: { $not: { note: { title: "x" } } } })
        .ok,
    ).toBe(true);
  });
  // Strapi reads a relation's own operator (or a bare value) as one on the related id.
  it("rewrites an operator on a relation itself as one on the related id, under the scope", () => {
    const under = (test: unknown) => ({ $and: [{ note: { $and: [{ id: test }, ENTRY, MINE] } }] });
    expect(scoped(member, { filters: { note: 5 } }).filters).toEqual(under(5));
    expect(scoped(member, { filters: { note: [5, 6] } }).filters).toEqual(under([5, 6]));
    expect(scoped(member, { filters: { note: { $eq: 5 } } }).filters).toEqual(under({ $eq: 5 }));
    expect(scoped(member, { filters: { note: { $in: [5] } } }).filters).toEqual(
      under({ $in: [5] }),
    );
    expect(scoped(member, { filters: { note: { $notNull: true } } }).filters).toEqual(
      under({ $notNull: true }),
    );
    expect(scoped(member, { filters: { note: { $null: false } } }).filters).toEqual(
      under({ $notNull: true }),
    );
    expect(scoped(member, { filters: { note: { $or: [{ title: "a" }] } } }).filters).toEqual({
      $and: [{ note: { $and: [{ $or: [{ title: "a" }] }, ENTRY, MINE] } }],
    });
    // A value over HTTP is a string, read as Strapi's parseType reads a boolean.
    expect(scoped(member, { filters: { note: { $null: "false" } } }).filters).toEqual(
      under({ $notNull: true }),
    );
    expect(scoped(member, { filters: { note: { $notNull: "t" } } }).filters).toEqual(
      under({ $notNull: true }),
    );
    for (const note of [{ $notNull: "false" }, { $null: "1" }, { $null: "yes" }, { $notNull: "" }])
      expect(scopeQuery(tables, TAG, member, { filters: { note } }).ok, JSON.stringify(note)).toBe(
        false,
      );
    // "Has none" would count an entry the caller cannot read as none.
    for (const note of [{ $null: true }, { $notNull: false }, { $in: [5], title: "x" }])
      expect(scopeQuery(tables, TAG, member, { filters: { note } }).ok, JSON.stringify(note)).toBe(
        false,
      );
    expect(scoped(member, { filters: { parent: { $null: true } } }).filters).toEqual({
      $and: [{ parent: { id: { $null: true } } }],
    });
  });
  it("keeps two relation filters at one level, and a client $and beside them, as separate items", () => {
    const titled = (title: string) => ({ $and: [{ title: { $eq: title } }, ENTRY, MINE] });
    expect(
      scoped(member, {
        filters: {
          label: { $eq: "a" },
          note: { title: { $eq: "x" } },
          parent: { note: { title: { $eq: "y" } } },
        },
      }).filters,
    ).toEqual({
      $and: [
        { label: { $eq: "a" } },
        { note: titled("x") },
        { parent: { $and: [{ note: titled("y") }] } },
      ],
    });
    expect(
      scoped(member, {
        filters: { $and: [{ label: { $eq: "a" } }], note: { title: { $eq: "x" } } },
      }).filters,
    ).toEqual({ $and: [{ $and: [{ label: { $eq: "a" } }] }, { note: titled("x") }] });
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
  it("scopes a component's populate filters and refuses a sort through its relations", () => {
    const filters = { note: { title: { $eq: "x" } } };
    expect(
      scoped(member, { populate: { refs: { filters, populate: ["note"] } } }).populate,
    ).toEqual({
      refs: {
        filters: { $and: [{ note: { $and: [{ title: { $eq: "x" } }, ENTRY, MINE] } }] },
        populate: { note: { filters: MINE } },
      },
    });
    expect(
      scoped(member, { populate: { blocks: { on: { [REF]: { filters } } } } }).populate,
    ).toEqual({
      blocks: {
        on: {
          [REF]: {
            filters: { $and: [{ note: { $and: [{ title: { $eq: "x" } }, ENTRY, MINE] } }] },
          },
        },
      },
    });
    expect(scopeQuery(tables, TAG, member, { populate: { refs: { sort: "note.title" } } }).ok).toBe(
      false,
    );
    expect(
      scopeQuery(tables, TAG, member, {
        populate: { blocks: { on: { [REF]: { sort: ["note.title"] } } } },
      }).ok,
    ).toBe(false);
    expect(
      scopeQuery(tables, TAG, member, { populate: { refs: { filters: { $not: filters } } } }).ok,
    ).toBe(false);
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

// i18n adds `localizations`, a relation of a localized type to its own other locales.
describe("scopeQuery: a localized type's localizations reach like any relation", () => {
  const localized: Tables = {
    rules: tables.rules,
    holders: {
      ...tables.holders,
      [TAG]: {
        populatable: ["localizations", "note"],
        links: { localizations: { relation: TAG }, note: { relation: NOTE } },
      },
      [NOTE]: { populatable: ["localizations"], links: { localizations: { relation: NOTE } } },
    },
  };
  const run = (uid: string, query: Record<string, unknown>) =>
    scopeQuery(localized, uid, member, query);
  it("scopes what a holder's localizations populate, filter and sort through", () => {
    const result = run(TAG, {
      populate: { localizations: { populate: { note: true } } },
      filters: { localizations: { note: { title: { $eq: "x" } } } },
    });
    expect(result.value).toEqual({
      populate: { localizations: { populate: { note: { filters: MINE } } } },
      filters: {
        $and: [
          { localizations: { $and: [{ note: { $and: [{ title: { $eq: "x" } }, ENTRY, MINE] } }] } },
        ],
      },
    });
    expect(run(TAG, { sort: "localizations.note.title:asc" }).ok).toBe(false);
    expect(run(TAG, { populate: "*" }).value?.populate).toEqual({
      localizations: true,
      note: { filters: MINE },
    });
  });
  it("narrows a conditioned type's own other locales to the rows the caller may read", () => {
    expect(run(NOTE, { populate: "localizations" }).value?.populate).toEqual({
      localizations: { filters: MINE },
    });
    expect(
      run(NOTE, { filters: { localizations: { title: { $eq: "x" } } } }).value?.filters,
    ).toEqual({ $and: [{ localizations: { $and: [{ title: { $eq: "x" } }, ENTRY, MINE] } }] });
    expect(run(NOTE, { sort: "localizations.title" }).ok).toBe(false);
  });
});

// The upload plugin's file has a polymorphic `related`: every entry the file is attached to.
describe("scopeQuery: a file's related entries are refused", () => {
  it("refuses related under a media populate, in any form, and keeps the rest of the file", () => {
    for (const populate of [
      { attachment: { populate: { related: true } } },
      { attachment: { populate: "*" } },
      { attachment: { populate: ["related"] } },
      { attachment: { populate: true } },
      "attachment.related",
    ]) {
      const result = scopeQuery(tables, NOTE, member, { populate });
      expect(result.ok, JSON.stringify(populate)).toBe(false);
    }
    expect(scopeQuery(tables, NOTE, member, { populate: "attachment" }).ok).toBe(true);
    expect(
      scopeQuery(tables, NOTE, member, { populate: { attachment: { populate: ["folder"] } } }).ok,
    ).toBe(true);
  });
});

describe("reachState: an open route reaches as a guest", () => {
  it("answers an `auth: false` action's reach as the public role, any other as the caller", () => {
    expect(reachState(rules, {}, "findOne")).toEqual({
      auth: { strategy: { name: "users-permissions" } },
    });
    expect(reachState(rules, member, "find")).toBe(member);
  });
  it("scopes an open route's populate by the public role's read", () => {
    const open: Tables = {
      ...tables,
      rules: { ...tables.rules, [TAG]: { ...tables.rules[TAG]!, open: ["find"] } },
    };
    const state = reachState(open.rules[TAG]!, {}, "find");
    expect(scopeQuery(open, TAG, state, { populate: "note" }).value?.populate).toEqual({
      note: { filters: SHARED },
    });
  });
});

// A link both sides show changes the entry on the other side, so writing it needs update there;
// a link whose other side holds one entry at most takes that entry from its last holder.
describe("writePlan: a relation write must be allowed on every entry it changes", () => {
  const reviewer = session("reviewer");
  const plan = (uid: string, data: Record<string, unknown>, state: unknown = reviewer) => {
    const result = writePlan(tables, uid, state, data);
    if (!result.ok) throw new Error(result.message);
    return result.value;
  };
  const none = { documentIds: [], ids: [] };
  it("needs update on each entry connected or disconnected through a link the target shows", () => {
    expect(plan(CATEGORY, { notes: { connect: [3], disconnect: ["n2"] } })).toEqual({
      refs: [{ target: NOTE, documentIds: ["n2"], ids: [3], action: "update" }],
      replaced: [],
      stolen: [],
    });
  });
  it("needs update on every entry a replacement drops: set, a list, null", () => {
    for (const notes of [{ set: [] }, [], null])
      expect(plan(CATEGORY, { notes }), JSON.stringify(notes)).toEqual({
        refs: [],
        replaced: [{ attribute: "notes", target: NOTE, kept: none }],
        stolen: [],
      });
    expect(plan(CATEGORY, { notes: ["n1"] })).toEqual({
      refs: [{ target: NOTE, documentIds: ["n1"], ids: [], action: "update" }],
      replaced: [{ attribute: "notes", target: NOTE, kept: { documentIds: ["n1"], ids: [] } }],
      stolen: [],
    });
  });
  it("replaces a to-one link on connect, and reads what it links through a reach", () => {
    expect(plan(TAG, { pinnedOn: { connect: ["n1"] } }, member)).toEqual({
      refs: [
        { target: NOTE, documentIds: ["n1"], ids: [], action: "read" },
        { target: NOTE, documentIds: ["n1"], ids: [], action: "update" },
      ],
      replaced: [{ attribute: "pinnedOn", target: NOTE, kept: { documentIds: ["n1"], ids: [] } }],
      stolen: [],
    });
  });
  it("takes an exclusive link's entries from their last holder, which must be the caller's to update", () => {
    expect(plan(NOTE, { pinned: { connect: ["t1"] } }, member)).toEqual({
      refs: [],
      replaced: [],
      stolen: [{ attribute: "pinned", documentIds: ["t1"], ids: [] }],
    });
  });
  it("plans nothing for a caller no role restricts", () => {
    expect(plan(CATEGORY, { notes: { set: [] } }, token)).toEqual({
      refs: [],
      replaced: [],
      stolen: [],
    });
  });
  it("loads the current links, and the dropped ones are those not kept", () => {
    expect(currentLinksQuery("notes", "c1")).toEqual({
      where: { documentId: "c1" },
      select: ["id"],
      populate: { notes: { select: ["id", "documentId"] } },
    });
    const rows = [
      {
        id: 1,
        notes: [
          { id: 3, documentId: "n1" },
          { id: 4, documentId: "n2" },
        ],
      },
    ];
    expect(droppedLinks(rows, "notes", { documentIds: ["n1"], ids: [] })).toEqual(["n2"]);
    expect(droppedLinks(rows, "notes", { documentIds: [], ids: [4] })).toEqual(["n1"]);
    expect(droppedLinks([{ id: 1, notes: { id: 4, documentId: "n2" } }], "notes", none)).toEqual([
      "n2",
    ]);
  });
  it("loads the last holders of a taken entry, other than the entry written", () => {
    const note = tables.rules[NOTE]!;
    expect(
      holdersQuery(note, { attribute: "pinned", documentIds: ["t1"], ids: [2] }, "mine"),
    ).toEqual({
      select: ["id", "shared", "documentId"],
      populate: { owner: { select: ["id"] } },
      where: {
        $and: [
          { pinned: { $or: [{ documentId: { $in: ["t1"] } }, { id: { $in: [2] } }] } },
          { documentId: { $ne: "mine" } },
        ],
      },
    });
    const caller = callerOf(note, member, "update");
    const theirs = [{ id: 2, documentId: "theirs", owner: { id: 8 } }];
    const mine = [{ id: 1, documentId: "mine", owner: { id: 7 } }];
    expect(holdersVerdict(note, caller, mine)).toBe("allow");
    expect(holdersVerdict(note, caller, [...mine, ...theirs])).toBe("forbidden");
    expect(holdersVerdict(note, caller, [])).toBe("allow");
  });
  it("checks update, not only read, where the link shows on the entry", () => {
    const ref = { target: NOTE, documentIds: ["n1"], ids: [] };
    const theirs = [{ id: 1, documentId: "n1", owner: { id: 8 } }];
    expect(refsVerdict(tables, reviewer, ref, theirs)).toBe("allow");
    expect(refsVerdict(tables, reviewer, ref, theirs, "update")).toBe("forbidden");
    expect(refsVerdict(tables, reviewer, ref, [{ ...theirs[0], owner: { id: 7 } }], "update")).toBe(
      "allow",
    );
  });
});
