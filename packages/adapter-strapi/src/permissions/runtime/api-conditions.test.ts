import { describe, expect, it } from "vitest";
import {
  callerOf,
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
