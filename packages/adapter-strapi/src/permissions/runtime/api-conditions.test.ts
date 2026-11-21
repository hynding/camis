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
  relationChange,
  writePlan,
  writeShape,
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
    shapes: tables.shapes,
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
// Strapi's publication cohorts compile to an EXISTS over the document's other version, which the
// caller may not read; and a parameter a later Strapi adds should be refused until reviewed.
describe("scopeQuery: only the parameters Strapi 5.48 documents pass, for a restricted caller", () => {
  const unlinked: Tables = {
    ...tables,
    holders: { [TAG]: tables.holders[TAG]!, [REF]: tables.holders[REF]! },
  };
  it("refuses publicationFilter and hasPublishedVersion, at the top and in a populate", () => {
    for (const query of [
      { publicationFilter: "never-published" },
      { hasPublishedVersion: "true" },
      { populate: { note: { publicationFilter: "has-published-version" } } },
      { populate: { parent: { populate: { note: { hasPublishedVersion: "false" } } } } },
      { populate: { refs: { populate: { note: { publicationFilter: "x" } } } } },
    ]) {
      expect(scopeQuery(tables, TAG, member, query).ok, JSON.stringify(query)).toBe(false);
    }
    // A conditioned type no holder table names is restricted all the same.
    expect(scopeQuery(unlinked, NOTE, member, { hasPublishedVersion: "true" }).ok).toBe(false);
    expect(scopeQuery(tables, NOTE, member, { publicationFilter: "x" }).ok).toBe(false);
    expect(scopeQuery(tables, TAG, token, { publicationFilter: "x" }).ok).toBe(true);
  });
  it("refuses a parameter it does not know, and lets every documented one through", () => {
    expect(scopeQuery(tables, TAG, member, { future: "1" }).ok).toBe(false);
    expect(scopeQuery(tables, TAG, member, { populate: { note: { future: true } } }).ok).toBe(
      false,
    );
    const known = {
      filters: { label: { $eq: "a" } },
      sort: "label",
      fields: ["label"],
      populate: {
        note: {
          fields: ["title"],
          sort: "title",
          filters: { title: { $eq: "x" } },
          count: true,
          ordering: "asc",
          page: 1,
          pageSize: 5,
          start: 0,
          limit: 5,
        },
        blocks: { on: { [REF]: { populate: ["note"] } } },
      },
      status: "published",
      locale: "en",
      page: 1,
      pageSize: 10,
      start: 0,
      limit: 10,
      pagination: { page: 1, pageSize: 10, withCount: true },
      _q: "a",
      count: true,
      ordering: "asc",
    };
    expect(scopeQuery(tables, TAG, member, known).ok).toBe(true);
  });
});

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

// Strapi's database layer spreads a relation or media item's `__pivot` into the join row it writes
// (entity-manager attachRelations/updateRelations), after the ids it was asked to link: so an item
// `{ id: <mine>, __pivot: { note_id: <theirs> } }` links theirs. Every item is read exactly.
describe("relation items: only the keys Strapi documents, each of its form", () => {
  const refs = (data: Record<string, unknown>) => relationRefs(tables, TAG, member, data);
  it("refuses __pivot, __type and any other key, in every place an item may stand", () => {
    const item = { id: 5, __pivot: { note_id: 9 } };
    for (const note of [
      item,
      [item],
      { connect: [item] },
      { set: [item] },
      { disconnect: [item] },
      { connect: item },
      { connect: [{ documentId: "d1", __pivot: { note_id: 9 } }] },
      { connect: [{ id: 5, __type: NOTE }] },
      { connect: [{ id: 5, extra: true }] },
      { connect: [5], other: [6] },
      { connect: [5], options: { strict: true, extra: 1 } },
      { connect: [5], options: "strict" },
    ])
      expect(refs({ note }), JSON.stringify(note)).toEqual({
        ok: false,
        message: "Invalid relation value for note",
      });
  });
  it("accepts id, documentId, locale, status and position, and options.strict", () => {
    expect(
      refs({
        note: {
          connect: [
            { documentId: "d1", locale: "fr", status: "published", position: { end: true } },
            { id: "6", position: { start: true } },
          ],
          options: { strict: false },
        },
      }),
    ).toEqual({ ok: true, value: [{ target: NOTE, documentIds: ["d1"], ids: [6] }] });
  });
  it("refuses an item naming both an id and a documentId, or neither, or a bad status or locale", () => {
    for (const item of [
      { id: 5, documentId: "d1" },
      { locale: "fr" },
      { id: 5, status: "archived" },
      { id: 5, locale: 3 },
      { id: 0 },
      { id: "5abc" },
    ])
      expect(refs({ note: { connect: [item] } }).ok, JSON.stringify(item)).toBe(false);
  });
  // Strapi's document service reads a string that parseInt reads as a number as a row id, and a
  // MySQL comparison reads "5abc" as 5: such a string is neither a documentId nor an id here.
  it("reads a string of digits as a row id and refuses one that only starts like a number", () => {
    expect(refs({ note: "12" })).toEqual({
      ok: true,
      value: [{ target: NOTE, documentIds: [], ids: [12] }],
    });
    for (const note of ["5abc", " 5", "-5", "0", "", ["7x"]])
      expect(refs({ note }).ok, JSON.stringify(note)).toBe(false);
  });
  // An anchor names an entry by documentId (or id), which Strapi looks up: unreadable, its error
  // would tell whether it exists. So an anchor must be readable like any linked entry.
  it("reads a position's before and after as entries to be read, and refuses other position keys", () => {
    expect(
      refs({ note: { connect: [{ documentId: "d1", position: { before: "d2", after: 3 } }] } }),
    ).toEqual({ ok: true, value: [{ target: NOTE, documentIds: ["d1", "d2"], ids: [3] }] });
    for (const position of [
      { middle: true },
      { before: { id: 3 } },
      { end: "yes" },
      "end",
      { before: "d2", locale: 3 },
      { before: "d2", status: "archived" },
      { before: "d2", __type: NOTE },
    ])
      expect(refs({ note: { connect: [{ id: 5, position }] } }).ok, JSON.stringify(position)).toBe(
        false,
      );
  });
  // Strapi looks an anchor up in the locale and status the position names (and, on a polymorphic
  // relation, its __type). The anchor is read on every row of its document, each locale and status.
  it("accepts a position's locale and status, and a polymorphic position's __type", () => {
    expect(
      refs({
        note: {
          connect: [
            { documentId: "d1", position: { before: "d2", locale: "fr", status: "draft" } },
          ],
        },
      }),
    ).toEqual({ ok: true, value: [{ target: NOTE, documentIds: ["d1", "d2"], ids: [] }] });
    expect(
      writeShape(tables, TAG, {
        subject: { connect: [{ id: 3, __type: NOTE, position: { after: 4, __type: TAG } }] },
      }),
    ).toEqual({ ok: true, value: true });
  });
});

describe("writePlan: what Strapi keeps is what is planned", () => {
  const reviewer = session("reviewer");
  // Strapi keeps only the last entry of a to-one write, so a list there would hide a drop.
  it("refuses more than one entry on a to-one attribute", () => {
    for (const pinnedOn of [["n1", "n2"], { connect: ["n1", "n2"] }, { set: ["n1", "n2"] }])
      expect(writePlan(tables, TAG, member, { pinnedOn }), JSON.stringify(pinnedOn)).toEqual({
        ok: false,
        message: "Invalid relation value for pinnedOn: one entry at most",
      });
  });
  // With a set, Strapi's database layer ignores connect and disconnect (and its document service
  // still looks up their entries): a write naming entries Strapi will not apply is refused.
  it("refuses a set beside a connect or a disconnect", () => {
    for (const notes of [
      { set: ["n1"], connect: ["n2"] },
      { set: 7, disconnect: ["n2"] },
      { set: [], connect: [] },
    ])
      expect(writePlan(tables, CATEGORY, reviewer, { notes }), JSON.stringify(notes)).toEqual({
        ok: false,
        message: "Invalid relation value for notes",
      });
  });
  // Strapi replaces the relation for any set it finds truthy, a single entry included.
  it("plans a replacement for a set of one entry, as Strapi applies it", () => {
    for (const [set, kept] of [
      ["n1", { documentIds: ["n1"], ids: [] }],
      [7, { documentIds: [], ids: [7] }],
      ["7", { documentIds: [], ids: [7] }],
      [{ id: 7 }, { documentIds: [], ids: [7] }],
      [{ documentId: "n1" }, { documentIds: ["n1"], ids: [] }],
    ] as const) {
      const result = writePlan(tables, CATEGORY, reviewer, { notes: { set } });
      expect(result.ok && result.value.replaced, JSON.stringify(set)).toEqual([
        { attribute: "notes", target: NOTE, kept },
      ]);
    }
    const unset = writePlan(tables, CATEGORY, reviewer, { notes: { set: null } });
    expect(unset.ok && unset.value.replaced).toEqual([]);
  });
});

// Every relation value camis accepts, in the one form Strapi 5.48 applies it: the document service
// (mapRelation) wraps a shorthand in a set and maps each part's items; the database layer
// (toAssocs) replaces the relation for a shorthand or a truthy set, and otherwise connects and
// disconnects. runtime/engine.test.ts runs the row id forms on Strapi's own entity manager.
describe("relationChange: each accepted relation value as the change Strapi makes", () => {
  const entries = (documentIds: string[] = [], ids: number[] = []) => ({ documentIds, ids });
  const none = entries();
  const replace = (connect = none) => ({
    mode: "replace",
    connect,
    disconnect: none,
    anchors: none,
  });
  const change = (connect = none, disconnect = none) => ({
    mode: "change",
    connect,
    disconnect,
    anchors: none,
  });
  const cases: [unknown, unknown][] = [
    [7, replace(entries([], [7]))],
    ["7", replace(entries([], [7]))],
    ["d1", replace(entries(["d1"]))],
    [[7, "d1"], replace(entries(["d1"], [7]))],
    [[], replace()],
    [null, replace()],
    [{ id: 7 }, replace(entries([], [7]))],
    [{ documentId: "d1", locale: "fr" }, replace(entries(["d1"]))],
    [{ connect: [7] }, change(entries([], [7]))],
    [{ connect: 7 }, change(entries([], [7]))],
    [{ connect: "d1" }, change(entries(["d1"]))],
    [{ disconnect: [7] }, change(none, entries([], [7]))],
    [{ connect: [7], disconnect: ["d1"] }, change(entries([], [7]), entries(["d1"]))],
    [{ connect: [7], options: { strict: false } }, change(entries([], [7]))],
    [{ options: { strict: true } }, change()],
    [{ set: [7] }, replace(entries([], [7]))],
    [{ set: { id: 7 } }, replace(entries([], [7]))],
    [{ set: "d1" }, replace(entries(["d1"]))],
    [{ set: 7 }, replace(entries([], [7]))],
    [{ set: "7" }, replace(entries([], [7]))],
    [{ set: [] }, replace()],
    [{ set: null }, change()],
    [{ set: null, connect: [7] }, change(entries([], [7]))],
    [{ set: [7], connect: null, disconnect: null }, replace(entries([], [7]))],
  ];
  it.each(cases)("reads %j", (value, expected) => {
    expect(relationChange(value, "relation")).toEqual(expected);
  });
  it("refuses a set beside connect or disconnect, and an empty object", () => {
    for (const value of [{ set: [7], connect: [8] }, { set: 7, disconnect: [] }, {}])
      expect(relationChange(value, "relation"), JSON.stringify(value)).toBeNull();
  });
  it("reads a media value's items as row ids only", () => {
    expect(relationChange({ set: 7 }, "media")).toEqual(replace(entries([], [7])));
    expect(relationChange({ connect: "7" }, "media")).toEqual(change(entries([], [7])));
    for (const value of [
      "d1",
      { documentId: "d1" },
      { connect: [{ id: 7, position: { end: true } }] },
    ])
      expect(relationChange(value, "media"), JSON.stringify(value)).toBeNull();
  });
});

describe("writeShape: a restricted caller's write names only the type's writable attributes", () => {
  const shape = (data: Record<string, unknown>, uid = TAG) => writeShape(tables, uid, data);
  it("passes a write of attributes in their forms, at every depth", () => {
    expect(
      shape({
        label: "x",
        note: { connect: [{ documentId: "d1" }] },
        parent: 3,
        refs: [{ id: 4, label: "r", note: "d2", image: 7 }],
        single: { image: { id: 8 } },
        blocks: [{ __component: REF, id: 2, note: null }],
        subject: [{ id: 3, __type: NOTE }],
      }),
    ).toEqual({ ok: true, value: true });
    expect(shape({ single: null, refs: [] })).toEqual({ ok: true, value: true });
    // Strapi clears a repeatable component or a dynamic zone written as null.
    expect(shape({ refs: null, blocks: null })).toEqual({ ok: true, value: true });
    expect(shape({ attachment: [3, "4", { id: 5 }], owner: 7 }, NOTE)).toEqual({
      ok: true,
      value: true,
    });
  });
  // Each of these Strapi or its database layer reads from a body; none is an attribute of camis's.
  it("refuses every key that is not an attribute: id, documentId, locale, publishedAt and the rest", () => {
    for (const key of [
      "id",
      "documentId",
      "locale",
      "publishedAt",
      "createdAt",
      "updatedAt",
      "createdBy",
      "updatedBy",
      "localizations",
      "__pivot",
      "__type",
      "__component",
      "__temp_key__",
      "constructor",
    ])
      expect(shape({ [key]: 1 }), key).toEqual({ ok: false, message: `Invalid key ${key}` });
  });
  it("refuses unknown keys inside components and zones, and a component of the wrong form", () => {
    expect(shape({ refs: [{ label: "r", __pivot: { cmp_id: 9 } }] })).toEqual({
      ok: false,
      message: "Invalid key refs.__pivot",
    });
    expect(shape({ single: { __temp_key__: 1 } })).toEqual({
      ok: false,
      message: "Invalid key single.__temp_key__",
    });
    expect(shape({ blocks: [{ __component: REF, documentId: "x" }] })).toEqual({
      ok: false,
      message: "Invalid key blocks.documentId",
    });
    for (const data of [
      { refs: { label: "r" } },
      { refs: [1] },
      { single: [{ label: "r" }] },
      { refs: [{ id: "x" }] },
      { blocks: [{ __component: "other.block" }] },
      { blocks: [{ label: "no component" }] },
      { blocks: { __component: REF } },
    ])
      expect(shape(data).ok, JSON.stringify(data)).toBe(false);
  });
  // Strapi keeps only the last entry of a to-one write, and decides on what it keeps: more than
  // one entry there would carry entries no check reads as written.
  it("refuses more than one entry on a to-one relation, at any depth", () => {
    for (const note of [["d1", "d2"], { connect: [1, 2] }, { set: [1, 2] }, [{ id: 1 }, 2]])
      expect(shape({ note }), JSON.stringify(note)).toEqual({
        ok: false,
        message: "Invalid relation value for note: one entry at most",
      });
    expect(shape({ refs: [{ note: [1, 2] }] })).toEqual({
      ok: false,
      message: "Invalid relation value for refs.note: one entry at most",
    });
    for (const note of [["d1"], { connect: [1], disconnect: [2] }, { set: 1 }, null, []])
      expect(shape({ note }), JSON.stringify(note)).toEqual({ ok: true, value: true });
    expect(shape({ notes: [1, 2, 3] }, CATEGORY)).toEqual({ ok: true, value: true });
  });
  it("refuses a relation, media or polymorphic value of any form but Strapi's documented ones", () => {
    expect(shape({ attachment: { connect: [{ id: 3, __pivot: { file_id: 9 } }] } }, NOTE)).toEqual({
      ok: false,
      message: "Invalid media value for attachment",
    });
    expect(shape({ refs: [{ image: { id: 3, __pivot: { related_id: 1 } } }] })).toEqual({
      ok: false,
      message: "Invalid media value for refs.image",
    });
    expect(shape({ note: { id: 3, __pivot: { note_id: 9 } } })).toEqual({
      ok: false,
      message: "Invalid relation value for note",
    });
    for (const subject of [[{ id: 3 }], [{ id: 3, __type: NOTE, __pivot: { field: "x" } }], 3])
      expect(shape({ subject }).ok, JSON.stringify(subject)).toBe(false);
  });
});
