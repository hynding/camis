import type { Condition, RecordData, Tables } from "../api-conditions";

// Tags reach notes directly, through a parent tag, a repeatable reference component and a
// dynamic zone of references; a member reads its own notes, a guest the shared ones.

/** The session user owns the record. */
export const owned: Condition = {
  test: (data: RecordData) =>
    data["user.id"] !== undefined && data["record.ownerId"] === data["user.id"],
  filter: { kind: "eq", variable: "record.ownerId", value: { kind: "user", variable: "user.id" } },
};
export const shared: Condition = {
  test: (data: RecordData) => data["record.shared"] === true,
  filter: { kind: "eq", variable: "record.shared", value: { kind: "literal", value: true } },
};
export const unshared: Condition = {
  test: (data: RecordData) => data["record.shared"] !== true,
  filter: null,
};
/** A condition with a null literal: the record has no owner. */
export const unowned: Condition = {
  test: (data: RecordData) => data["record.ownerId"] === null,
  filter: { kind: "eq", variable: "record.ownerId", value: { kind: "literal", value: null } },
};
export const NOTE = "api::note.note";
export const TAG = "api::tag.tag";
export const CATEGORY = "api::category.category";
export const REF = "shared.reference";
export const tables: Tables = {
  rules: {
    [NOTE]: {
      own: true,
      defaults: { "record.shared": true },
      relations: { pinned: { target: TAG, mirrored: true, toOne: false, exclusive: true } },
      variables: {
        "record.ownerId": { field: "owner", relation: true },
        "record.shared": { field: "shared", relation: false },
      },
      open: [],
      assign: ["owner"],
      admins: ["manager"],
      roles: {
        member: { read: [owned], create: [owned], update: [owned], assign: ["owner"] },
        contributor: { create: [unshared], assign: ["owner"] },
        public: { read: [shared], assign: [] },
        drafter: { read: [unowned], assign: [] },
        reviewer: { read: true, update: [owned], assign: [] },
      },
    },
    [CATEGORY]: {
      own: false,
      defaults: {},
      relations: { notes: { target: NOTE, mirrored: true, toOne: false, exclusive: true } },
      variables: {},
      open: [],
      assign: [],
      admins: ["manager"],
      roles: {},
    },
    [TAG]: {
      own: false,
      defaults: {},
      relations: { pinnedOn: { target: NOTE, mirrored: true, toOne: true, exclusive: false } },
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
        pinnedOn: { relation: NOTE },
      },
    },
    [REF]: { populatable: ["note"], links: { note: { relation: NOTE } } },
    [NOTE]: { populatable: ["attachment", "owner"], links: { attachment: { media: true } } },
  },
  shapes: {
    [NOTE]: {
      owner: "toOneRelation",
      title: "scalar",
      shared: "scalar",
      attachment: "media",
      category: "toOneRelation",
      pinned: "relation",
    },
    [CATEGORY]: { label: "scalar", notes: "relation" },
    [TAG]: {
      label: "scalar",
      note: "toOneRelation",
      parent: "toOneRelation",
      refs: { component: REF, repeatable: true },
      single: { component: REF, repeatable: false },
      blocks: { zone: [REF] },
      pinnedOn: "toOneRelation",
      subject: "polymorphic",
      about: "toOnePolymorphic",
      cover: "toOneMedia",
    },
    [REF]: { label: "scalar", note: "toOneRelation", image: "media" },
  },
};
