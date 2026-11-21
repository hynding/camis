import { describe, expect, it } from "vitest";
import type { Tables } from "./api-conditions";
import {
  attachField,
  attachVerdict,
  changeVerdict,
  fileQuery,
  mediaFileIds,
  relatedEntries,
  uploadCaller,
  uploaderOf,
  uploadRequest,
  entryVerdict,
  type StoredFile,
} from "./api-uploads";
import { NOTE, REF, TAG, tables } from "./__fixtures__/reach-tables";

const HOME = "api::home.home";
const withUploads: Tables = {
  ...tables,
  uploads: {
    admins: ["manager"],
    uploaderRecorded: true,
    holders: {
      [HOME]: { fields: ["banner"], nested: {} },
      [NOTE]: { fields: ["attachment"], nested: {} },
      [REF]: { fields: ["image"], nested: {} },
      [TAG]: { fields: [], nested: { blocks: { zone: [REF] }, refs: { component: REF } } },
    },
    grants: {
      [HOME]: { read: ["member"], update: ["editor"] },
      [NOTE]: { read: ["reviewer"], update: [] },
      [TAG]: { read: ["member", "public", "reviewer"], update: [] },
    },
  },
};
const uploads = withUploads.uploads!;

const session = (id: number, role: string) => ({
  auth: { strategy: { name: "users-permissions" } },
  user: { id, documentId: `user-${id}`, role: { type: role } },
});
const alice = session(7, "member");
const guest = { auth: { strategy: { name: "users-permissions" } } };
const token = { auth: { strategy: { name: "api-token" } } };
const noRole = { user: { id: 7, documentId: "user-7" } };

/** A note's rows (each version and locale), as recordQuery loads them. */
const note = (...owners: (number | null)[]) =>
  owners.map((owner, i) => ({ id: i + 1, owner: owner === null ? null : { id: owner } }));
const home = [{ id: 1, documentId: "home" }];

describe("uploadRequest: the request shapes a restricted caller's POST /api/upload may take", () => {
  it("an upload with no ref attaches nothing, whatever the fileInfo's form", () => {
    for (const body of [undefined, {}, { fileInfo: '{"name":"a"}' }, { fileInfo: ["{}", "{}"] }])
      expect(uploadRequest({}, body)).toEqual({
        ok: true,
        value: { kind: "upload", attach: null },
      });
  });
  it("ref, refId and field name the entry and its media field; refId is a row id", () => {
    const attach = { uid: NOTE, id: 5, field: "attachment" };
    for (const refId of ["5", 5])
      expect(uploadRequest({}, { ref: NOTE, refId, field: "attachment" })).toEqual({
        ok: true,
        value: { kind: "upload", attach },
      });
  });
  it("refuses a refId that is not a positive row id: a documentId, a decimal, zero, a sign", () => {
    for (const refId of ["abc123", "05", "5.0", "1e3", "-1", "0", "", " 5", 5.5, 0, -2, true, {}])
      expect(uploadRequest({}, { ref: NOTE, refId, field: "attachment" }).ok, String(refId)).toBe(
        false,
      );
  });
  it("refuses a repeated multipart field, which arrives as an array", () => {
    for (const body of [
      { ref: [NOTE, NOTE], refId: "1", field: "attachment" },
      { ref: NOTE, refId: ["1", "2"], field: "attachment" },
      { ref: NOTE, refId: "1", field: ["attachment", "attachment"] },
    ])
      expect(uploadRequest({}, body).ok).toBe(false);
  });
  it("refuses ref, refId and field unless all three come together, each non-empty", () => {
    for (const body of [
      { ref: NOTE },
      { refId: "1" },
      { field: "attachment" },
      { ref: NOTE, refId: "1" },
      { refId: "1", field: "attachment" },
      { ref: NOTE, refId: "1", field: "" },
      { ref: "", refId: "1", field: "attachment" },
    ])
      expect(uploadRequest({}, body), JSON.stringify(body)).toMatchObject({ ok: false });
  });
  // Strapi's upload keeps every body field but fileInfo as a meta: `path` reaches the stored
  // file, and a later Strapi may read more. Only the documented fields pass.
  it("refuses any other body field: path, folder, source, a files text field", () => {
    for (const key of ["path", "folder", "source", "files", "tmpWorkingDirectory", "related"])
      expect(uploadRequest({}, { [key]: "x" }), key).toEqual({
        ok: false,
        message: `Invalid upload field ${key}`,
      });
    expect(uploadRequest({}, "ref=api::note.note").ok).toBe(false);
  });
  it("?id= replaces a file (or, with no file, updates its info): a positive row id alone", () => {
    expect(uploadRequest({ id: "7" }, { fileInfo: "{}" })).toEqual({
      ok: true,
      value: { kind: "change", id: 7 },
    });
    for (const id of ["", "abc", "07", ["7", "8"], "-7"])
      expect(uploadRequest({ id }, {}).ok, String(id)).toBe(false);
    expect(uploadRequest({ id: "7" }, { ref: NOTE, refId: "1", field: "attachment" })).toEqual({
      ok: false,
      message: "Invalid ref, refId and field on a replace",
    });
  });
  it("refuses any query parameter but id", () => {
    for (const key of ["populate", "filters", "folder", "ref"])
      expect(uploadRequest({ [key]: "x" }, {}), key).toEqual({
        ok: false,
        message: `Invalid query parameter ${key}`,
      });
  });
});

describe("attachField: the entry a new file may be attached to", () => {
  it("is a content type's own media field", () => {
    expect(attachField(uploads, { uid: NOTE, id: 1, field: "attachment" })).toBe(true);
    expect(attachField(uploads, { uid: HOME, id: 1, field: "banner" })).toBe(true);
  });
  // A component's rows belong to the entry that holds them, which the upload names nowhere, and
  // a nested path is not an attribute: both are refused rather than traced to their entry.
  it("never a component, a plugin's type, a non-media or nested field, or a prototype key", () => {
    for (const [uid, field] of [
      [NOTE, "title"],
      [NOTE, "owner"],
      [TAG, "refs"],
      [TAG, "refs.image"],
      [REF, "image"],
      ["plugin::users-permissions.user", "avatar"],
      ["constructor", "attachment"],
      [NOTE, "__proto__"],
      [NOTE, "constructor"],
    ] as const)
      expect(attachField(uploads, { uid, id: 1, field }), `${uid} ${field}`).toBe(false);
  });
});

describe("uploadCaller", () => {
  it("an API token and an admin role are unrestricted; a session acts as its role", () => {
    expect(uploadCaller(uploads, token).kind).toBe("unrestricted");
    expect(uploadCaller(uploads, session(1, "manager")).kind).toBe("unrestricted");
    expect(uploadCaller(uploads, alice)).toMatchObject({ kind: "role", role: "member" });
    expect(uploadCaller(uploads, guest)).toMatchObject({ kind: "role", role: "public" });
    expect(uploadCaller(uploads, noRole).kind).toBe("refused");
  });
});

describe("uploaderOf", () => {
  it("is the session user's id; none for a guest or a token", () => {
    expect(uploaderOf(alice)).toBe(7);
    expect(uploaderOf(guest)).toBeNull();
    expect(uploaderOf(token)).toBeNull();
  });
});

describe("entryVerdict: the caller's verdict on an existing entry", () => {
  it("decides a type with rules on every row of the entry", () => {
    expect(entryVerdict(withUploads, NOTE, alice, "update", note(7))).toBe(true);
    expect(entryVerdict(withUploads, NOTE, alice, "update", note(8))).toBe(false);
    expect(entryVerdict(withUploads, NOTE, alice, "update", note(7, 8))).toBe(false);
    const reviewer = session(7, "reviewer");
    expect(entryVerdict(withUploads, NOTE, reviewer, "read", note(8))).toBe(true);
    expect(entryVerdict(withUploads, NOTE, reviewer, "update", note(8))).toBe(false);
  });
  it("decides a type with no rules (a single type included) by the roles holding it outright", () => {
    expect(entryVerdict(withUploads, HOME, session(7, "editor"), "update", home)).toBe(true);
    expect(entryVerdict(withUploads, HOME, alice, "update", home)).toBe(false);
    expect(entryVerdict(withUploads, HOME, alice, "read", home)).toBe(true);
    expect(entryVerdict(withUploads, TAG, guest, "read", [{ id: 1 }])).toBe(true);
  });
  it("refuses an entry that does not exist, a component's row and an unknown type", () => {
    expect(entryVerdict(withUploads, NOTE, alice, "update", [])).toBe(false);
    expect(entryVerdict(withUploads, HOME, session(7, "editor"), "update", [])).toBe(false);
    expect(entryVerdict(withUploads, REF, alice, "read", [{ id: 1 }])).toBe(false);
    expect(entryVerdict(withUploads, "api::other.other", token, "read", [{ id: 1 }])).toBe(false);
  });
  it("lets an unrestricted caller act on any entry that exists; refuses a refused one", () => {
    expect(entryVerdict(withUploads, NOTE, token, "update", note(8))).toBe(true);
    expect(entryVerdict(withUploads, NOTE, token, "update", [])).toBe(false);
    expect(entryVerdict(withUploads, NOTE, noRole, "update", note(7))).toBe(false);
  });
});

const file = (uploader: number | null, ...related: StoredFile["related"]): StoredFile => ({
  uploader,
  related,
});

describe("changeVerdict: replacing or deleting a stored file", () => {
  it("an unattached file only by its uploader", () => {
    expect(changeVerdict(withUploads, alice, file(7))).toBe(true);
    expect(changeVerdict(withUploads, alice, file(8))).toBe(false);
    expect(changeVerdict(withUploads, alice, file(null))).toBe(false);
    expect(changeVerdict(withUploads, guest, file(null))).toBe(false);
  });
  it("an attached file when the caller may update every entry it is related to", () => {
    expect(changeVerdict(withUploads, alice, file(8, { uid: NOTE, rows: note(7) }))).toBe(true);
    expect(
      changeVerdict(
        withUploads,
        alice,
        file(8, { uid: NOTE, rows: note(7) }, { uid: NOTE, rows: note(8) }),
      ),
    ).toBe(false);
  });
  // Whoever links a file follows it: no one may take control of a file from its uploader by
  // linking it to an entry of theirs.
  it("always by its uploader, wherever the file is attached", () => {
    expect(changeVerdict(withUploads, alice, file(7, { uid: NOTE, rows: note(8) }))).toBe(true);
    expect(changeVerdict(withUploads, alice, file(7, { uid: REF, rows: [{ id: 1 }] }))).toBe(true);
  });
  it("refuses another's file on a component's row, an entry gone missing, or a file that does not exist", () => {
    expect(changeVerdict(withUploads, alice, file(8, { uid: REF, rows: [{ id: 1 }] }))).toBe(false);
    expect(changeVerdict(withUploads, alice, file(8, { uid: NOTE, rows: [] }))).toBe(false);
    expect(changeVerdict(withUploads, alice, file(8, { uid: "", rows: [] }))).toBe(false);
    expect(changeVerdict(withUploads, alice, null)).toBe(false);
  });
});

describe("attachVerdict: linking a stored file to an entry through a media field", () => {
  it("allows the file's uploader, wherever the file is attached", () => {
    expect(attachVerdict(withUploads, alice, file(7))).toBe(true);
    expect(attachVerdict(withUploads, alice, file(7, { uid: NOTE, rows: note(8) }))).toBe(true);
  });
  it("allows a file related to an entry the caller may update", () => {
    expect(attachVerdict(withUploads, alice, file(8, { uid: NOTE, rows: note(7) }))).toBe(true);
    expect(
      attachVerdict(
        withUploads,
        alice,
        file(8, { uid: NOTE, rows: note(8) }, { uid: NOTE, rows: note(7) }),
      ),
    ).toBe(true);
    const editor = session(9, "editor");
    expect(attachVerdict(withUploads, editor, file(8, { uid: HOME, rows: home }))).toBe(true);
  });
  // Reading an entry is no claim on its file: linking it would make the file's owner need the
  // linker's entry to replace or delete it (before uploaders kept their files) and copies a link
  // the reader could not make by uploading.
  it("refuses a file only on entries the caller may read but not update", () => {
    const reviewer = session(9, "reviewer");
    expect(attachVerdict(withUploads, reviewer, file(8, { uid: NOTE, rows: note(8) }))).toBe(false);
    expect(attachVerdict(withUploads, alice, file(8, { uid: HOME, rows: home }))).toBe(false);
  });
  it("refuses another's file that is unattached, on entries the caller cannot read, or on a component", () => {
    expect(attachVerdict(withUploads, alice, file(8))).toBe(false);
    expect(attachVerdict(withUploads, alice, file(null))).toBe(false);
    expect(attachVerdict(withUploads, alice, file(8, { uid: NOTE, rows: note(8) }))).toBe(false);
    expect(attachVerdict(withUploads, alice, file(8, { uid: REF, rows: [{ id: 1 }] }))).toBe(false);
    expect(attachVerdict(withUploads, alice, null)).toBe(false);
    expect(attachVerdict(withUploads, guest, file(null))).toBe(false);
  });
  // With no role writing files there is no upload extension: no file has a recorded uploader.
  it("decides by the entries alone where no uploader is recorded", () => {
    const unrecorded: Tables = { ...withUploads, uploads: { ...uploads, uploaderRecorded: false } };
    expect(attachVerdict(unrecorded, alice, file(7))).toBe(false);
    expect(attachVerdict(unrecorded, alice, file(7, { uid: NOTE, rows: note(7) }))).toBe(true);
    expect(changeVerdict(unrecorded, alice, file(7))).toBe(false);
    expect(fileQuery(4, false)).toEqual({
      where: { id: 4 },
      select: ["id"],
      populate: { related: true },
    });
  });
});

describe("mediaFileIds: the stored files an entry write links through its media fields", () => {
  const ids = (data: Record<string, unknown>, uid = NOTE, state: unknown = alice) =>
    mediaFileIds(withUploads, uid, state, data);
  // The forms Strapi 5.48's database layer reads a media value in (toAssocs): an id, a list, an
  // object with an id, or connect and set lists; a string is read as a row id there.
  it("reads every form Strapi accepts as a row id", () => {
    expect(ids({ attachment: 3 })).toEqual({ ok: true, value: [3] });
    expect(ids({ attachment: "3" })).toEqual({ ok: true, value: [3] });
    expect(ids({ attachment: { id: 3 } })).toEqual({ ok: true, value: [3] });
    expect(ids({ attachment: [3, { id: "4" }] })).toEqual({ ok: true, value: [3, 4] });
    expect(
      ids({ attachment: { connect: [5], disconnect: [7], options: { strict: true } } }),
    ).toEqual({ ok: true, value: [5] });
    expect(ids({ attachment: { set: [{ id: 6 }] } })).toEqual({ ok: true, value: [6] });
    expect(ids({ attachment: { set: 6 } })).toEqual({ ok: true, value: [6] });
    expect(ids({ attachment: { connect: "3" } })).toEqual({ ok: true, value: [3] });
    expect(ids({ attachment: null })).toEqual({ ok: true, value: [] });
    expect(ids({ attachment: { set: null } })).toEqual({ ok: true, value: [] });
    expect(ids({ title: 3 })).toEqual({ ok: true, value: [] });
  });
  it("refuses any other form: a documentId, a non-positive or decimal id, an unknown object", () => {
    for (const value of [
      "abc",
      "05",
      { documentId: "abc" },
      0,
      -1,
      1.5,
      true,
      { id: "abc" },
      { id: 0 },
      { foo: 1 },
      [3, "abc"],
      { connect: [{ documentId: "abc" }] },
      { connect: [5], set: [6] },
      // Strapi's database layer spreads __pivot into the join row: file_id, related_id and
      // related_type would name another file or entry than the id checked.
      { id: 3, __pivot: { file_id: 9 } },
      { connect: [{ id: 3, __pivot: { file_id: 9 } }] },
      { set: [{ id: 3, __pivot: { related_id: 1 } }] },
      { disconnect: [{ id: 3, __pivot: { related_type: "api::other.other" } }] },
      [{ id: 3, __pivot: {} }],
      { connect: [{ id: 3, position: { end: true } }] },
      { connect: [3], options: { strict: true, other: 1 } },
      { id: 3, connect: [4] },
    ])
      expect(ids({ attachment: value }), JSON.stringify(value)).toEqual({
        ok: false,
        message: "Invalid media value for attachment",
      });
  });
  it("walks components and dynamic zones at any depth", () => {
    expect(
      ids(
        {
          refs: [{ image: 8 }, { image: null }],
          blocks: [
            { __component: REF, image: 9 },
            { __component: "other.block", image: 10 },
          ],
        },
        TAG,
      ),
    ).toEqual({ ok: true, value: [8, 9] });
    expect(ids({ refs: { image: 8 } }, TAG)).toEqual({ ok: true, value: [8] });
    expect(ids({ refs: [{ image: "abc" }] }, TAG).ok).toBe(false);
  });
  it("asks nothing of an unrestricted caller, nor of a project with no upload enforcement", () => {
    expect(ids({ attachment: "abc" }, NOTE, token)).toEqual({ ok: true, value: [] });
    expect(mediaFileIds(tables, NOTE, alice, { attachment: 3 })).toEqual({ ok: true, value: [] });
  });
});

describe("relatedEntries and fileQuery", () => {
  it("loads a file with its uploader and the entries it is attached to", () => {
    expect(fileQuery(4, true)).toEqual({
      where: { id: 4 },
      select: ["id", "camisUploader"],
      populate: { related: true },
    });
  });
  it("reads each related entry's type and row id; anything else as an unknown type", () => {
    expect(
      relatedEntries({
        related: [{ __type: NOTE, id: 1, title: "x" }, { __type: REF, id: 2 }, { id: 3 }],
      }),
    ).toEqual([
      { uid: NOTE, id: 1 },
      { uid: REF, id: 2 },
      { uid: "", id: 3 },
    ]);
    expect(relatedEntries({})).toEqual([]);
  });
});
