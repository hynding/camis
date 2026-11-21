// Generates the ownership fixture's Strapi project, boots it on sqlite and checks over HTTP that
// the generated controllers enforce the IR's row conditions, assigned owner and relation reach
// against a real Strapi 5 (the unit tests run them against a fake of its surface only).
// Runs in the gated CI job; cannot run in the restricted dev sandbox (npm denied).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialize } from "@camis/adapter-kernel";
import { strapiAdapter } from "../src/generate";
import { ownershipBundle } from "../src/__fixtures__/ownership";
import { routeProblems, type Granted, type ListedRoute } from "./route-guard";
import { stopProcessGroup } from "./stop-process-group";

const BASE = "http://127.0.0.1:1337";

interface Response {
  status: number;
  body: { data?: unknown; jwt?: string; user?: { id: number } } | null;
}

const call = async (
  method: string,
  path: string,
  jwt?: string,
  data?: unknown,
): Promise<Response> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(jwt === undefined ? {} : { authorization: `Bearer ${jwt}` }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : (JSON.parse(text) as Response["body"]) };
};

const failures: string[] = [];
const check = (what: string, ok: boolean, detail: unknown): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(`${what}: ${JSON.stringify(detail)}`);
};

const rows = (r: Response): { documentId: string; [key: string]: unknown }[] =>
  Array.isArray(r.body?.data) ? (r.body.data as { documentId: string }[]) : [];

/** A list request that must answer 200: an error page never passes for an empty list. */
const list = async (
  path: string,
  jwt?: string,
): Promise<{ ok: boolean; ids: string[]; response: Response }> => {
  const response = await call("GET", path, jwt);
  return {
    ok: response.status === 200 && Array.isArray(response.body?.data),
    ids: rows(response).map((r) => r.documentId),
    response,
  };
};
const idOf = (r: Response): string =>
  (r.body?.data as { documentId?: string } | undefined)?.documentId ?? "";

const pollUntilUp = async (timeoutMs: number): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // The public role reads shared notes, so a booted project answers 200.
      const res = await fetch(`${BASE}/api/notes`);
      if (res.status === 200) return true;
      if (res.status === 404 || res.status >= 500) return false;
    } catch {
      /* server not up yet */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
};

interface Database {
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    all(...args: unknown[]): Record<string, unknown>[];
  };
  close(): void;
}

/** The project's sqlite database, opened with the better-sqlite3 it installed. */
const database = (dir: string): Database => {
  const require = createRequire(join(dir, "package.json"));
  const Sqlite = require("better-sqlite3") as new (file: string) => Database;
  return new Sqlite(join(dir, ".tmp", "data.db"));
};

/** Rows of a query on the project's database, which stays closed between requests. */
const select = (dir: string, sql: string, ...args: unknown[]): Record<string, unknown>[] => {
  const db = database(dir);
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
};

/** A statement on the project's database. */
const run = (dir: string, sql: string, ...args: unknown[]): void => {
  const db = database(dir);
  try {
    db.prepare(sql).run(...args);
  } finally {
    db.close();
  }
};

/** A body for POST /api/upload: its text fields, and one small file unless `file` is false. */
const form = (fields: Record<string, string>, file = true): FormData => {
  const body = new FormData();
  if (file) body.append("files", new Blob(["camis"], { type: "text/plain" }), "note.txt");
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return body;
};

const send = async (method: string, path: string, jwt: string, body?: FormData) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${jwt}` },
    ...(body === undefined ? {} : { body }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? null : (JSON.parse(text) as unknown) };
};

/** A registered account (which users-permissions puts in its default role), moved to `role`. */
const member = async (dir: string, name: string, role = "member") => {
  const registered = await call("POST", "/api/auth/local/register", undefined, {
    username: name,
    email: `${name}@example.test`,
    password: "Passw0rd!camis",
  });
  if (registered.status !== 200 || registered.body?.jwt === undefined)
    throw new Error(`register ${name}: ${JSON.stringify(registered)}`);
  // users-permissions has no API to change a user's role short of the admin panel, so move the
  // account in the database. The JWT names only the user; its role is loaded on every request.
  const db = database(dir);
  try {
    const moved = db
      .prepare(
        "UPDATE up_users_role_lnk SET role_id = (SELECT id FROM up_roles WHERE type = ?) WHERE user_id = ?",
      )
      .run(role, registered.body.user!.id);
    if (moved.changes !== 1) throw new Error(`move ${name} to ${role}: ${moved.changes} rows`);
  } finally {
    db.close();
  }
  return { jwt: registered.body.jwt, id: registered.body.user!.id };
};

const scenario = async (dir: string): Promise<void> => {
  const alice = await member(dir, "alice");
  const bob = await member(dir, "bob");

  // alice names bob as the owner; the server assigns alice instead.
  const created = await call("POST", "/api/notes", alice.jwt, {
    data: { title: "alice's", shared: false, owner: bob.id },
  });
  check("alice creates a note", created.status === 201, created);
  const aliceNote = (created.body?.data as { documentId?: string } | undefined)?.documentId ?? "";
  const aliceList = await list("/api/notes", alice.jwt);
  check(
    "the client-supplied owner is overridden: alice lists her note",
    aliceList.ok && aliceList.ids.includes(aliceNote),
    aliceList.response,
  );
  const bobList = await list("/api/notes", bob.jwt);
  check(
    "bob does not list alice's note",
    bobList.ok && !bobList.ids.includes(aliceNote),
    bobList.response,
  );
  for (const [method, data] of [
    ["GET", undefined],
    ["PUT", { data: { title: "bob was here" } }],
    ["DELETE", undefined],
  ] as const) {
    const r = await call(method, `/api/notes/${aliceNote}`, bob.jwt, data);
    check(`bob's ${method} of alice's note is 404`, r.status === 404, r);
  }
  const still = await call("GET", `/api/notes/${aliceNote}`, alice.jwt);
  check(
    "alice's note is unchanged",
    (still.body?.data as { title?: string } | undefined)?.title === "alice's",
    still,
  );

  // The member role writes the owner relation only through assign, so it lacks user.find.
  const users = await call("GET", "/api/users", alice.jwt);
  check("the member role has no GET /api/users", users.status === 403, users.status);

  // A tag of bob's links bob's private note; neither alice nor a guest sees the note through it.
  const bobNote = await call("POST", "/api/notes", bob.jwt, {
    data: { title: "bob's", shared: false },
  });
  const bobNoteId = (bobNote.body?.data as { documentId?: string } | undefined)?.documentId;
  const tag = await call("POST", "/api/tags", bob.jwt, { data: { label: "b", note: bobNoteId } });
  check("bob tags his own note", tag.status === 201, tag);
  const tagId = (tag.body?.data as { documentId?: string } | undefined)?.documentId;
  // The tag itself must be listed, so a missing tag never passes for a hidden note.
  const listed = (r: Response) => rows(r).some((t) => t.documentId === tagId);
  const noteOf = (r: Response) => rows(r).find((t) => t.documentId === tagId)?.note;
  const asBob = await call("GET", "/api/tags?populate=note", bob.jwt);
  check("bob sees his note through his tag", noteOf(asBob) != null, asBob);
  for (const [who, jwt] of [
    ["alice", alice.jwt],
    ["a guest", undefined],
  ] as const) {
    for (const query of ["populate=note", "populate=*", "populate[note][fields][0]=title"]) {
      const r = await call("GET", `/api/tags?${query}`, jwt);
      check(
        `${who} sees no note through bob's tag (${query})`,
        r.status === 200 && listed(r) && noteOf(r) == null,
        r,
      );
    }
  }
  const byTitle = "/api/tags?filters[note][title][$eq]=bob%27s";
  const oracle = await list(byTitle, alice.jwt);
  check(
    "alice's filter on bob's note matches nothing",
    oracle.ok && oracle.ids.length === 0,
    oracle.response,
  );
  const control = await list(byTitle, bob.jwt);
  check(
    "bob's same filter finds his tag",
    control.ok && control.ids.includes(tagId ?? ""),
    control.response,
  );

  // Two scoped relation filters at one level: neither may overwrite the other in Strapi's merge.
  const child = await call("POST", "/api/tags", bob.jwt, {
    data: { label: "b2", note: bobNoteId, parent: tagId },
  });
  check("bob tags his note again, under his first tag", child.status === 201, child);
  const both = (title: string) =>
    `/api/tags?filters[note][title][$eq]=${title}&filters[parent][note][title][$eq]=bob%27s`;
  const neither = await list(both("nothing"), bob.jwt);
  check(
    "two relation filters both apply: no match",
    neither.ok && neither.ids.length === 0,
    neither.response,
  );
  const matched = await list(both("bob%27s"), bob.jwt);
  check(
    "two relation filters both apply: the child tag",
    matched.ok && matched.ids.length === 1 && matched.ids[0] === idOf(child),
    matched.response,
  );

  // A file's related entries may be any entry the file is attached to.
  const related = await call(
    "GET",
    "/api/notes?populate[attachment][populate][related]=true",
    alice.jwt,
  );
  check("a file's related entries are refused", related.status === 400, related.status);
  const attachment = await list("/api/notes?populate=attachment", alice.jwt);
  check("a note's attachment still populates", attachment.ok, attachment.response);

  // A tag is pinned on one note at most: pinning bob's tag on alice's note would unpin it from his.
  const pin = await call("PUT", `/api/notes/${bobNoteId}`, bob.jwt, {
    data: { pinned: { connect: [tagId] } },
  });
  check("bob pins his tag on his note", pin.status === 200, pin);
  const steal = await call("PUT", `/api/notes/${aliceNote}`, alice.jwt, {
    data: { pinned: { connect: [tagId] } },
  });
  check("alice cannot take bob's pinned tag", steal.status === 403, steal);
  const pinned = await call("GET", `/api/notes/${bobNoteId}?populate=pinned`, bob.jwt);
  const pins = (pinned.body?.data as { pinned?: { documentId: string }[] } | undefined)?.pinned;
  check(
    "bob's note still pins his tag",
    pinned.status === 200 && (pins ?? []).some((t) => t.documentId === tagId),
    pinned,
  );
  const pinOn = await call("POST", "/api/tags", alice.jwt, {
    data: { label: "a2", pinnedOn: bobNoteId },
  });
  check("alice cannot pin a tag on bob's note", pinOn.status === 403, pinOn);
  const sort = await call("GET", "/api/tags?sort=note.title:asc", alice.jwt);
  check("alice's sort through the note is refused", sort.status === 400, sort.status);

  // SQL's NOT of an unknown is unknown, so a $not around a scoped relation could answer a guess.
  const negated = await call("GET", "/api/tags?filters[$not][note][title][$eq]=bob%27s", alice.jwt);
  check("alice's $not around the note filter is refused", negated.status === 400, negated.status);
  const none = await call("GET", "/api/tags?filters[note][$null]=true", alice.jwt);
  check("alice's $null on the note relation is refused", none.status === 400, none.status);
  const some = (jwt: string) => list("/api/tags?filters[note][$notNull]=true", jwt);
  const bobSome = await some(bob.jwt);
  check(
    "bob's $notNull on the note relation finds his tag",
    bobSome.ok && bobSome.ids.includes(tagId ?? ""),
    bobSome.response,
  );
  const aliceSome = await some(alice.jwt);
  check(
    "alice's $notNull on the note relation skips bob's tag",
    aliceSome.ok && !aliceSome.ids.includes(tagId ?? ""),
    aliceSome.response,
  );

  // A component's rows are the tag's, but a populate filter on them through the note is scoped.
  const withRefs = await call("POST", "/api/tags", bob.jwt, {
    data: { label: "b3", refs: [{ note: bobNoteId }] },
  });
  check("bob tags with a reference to his note", withRefs.status === 201, withRefs);
  const refsOf = async (jwt: string) => {
    const r = await list(
      `/api/tags?filters[documentId][$eq]=${idOf(withRefs)}` +
        "&populate[refs][filters][note][title][$eq]=bob%27s&populate[refs][populate]=note",
      jwt,
    );
    const tag = rows(r.response)[0] as { refs?: unknown[] } | undefined;
    return { ok: r.ok && tag !== undefined, refs: tag?.refs ?? [], response: r.response };
  };
  const bobRefs = await refsOf(bob.jwt);
  check(
    "bob's component populate filter finds his reference",
    bobRefs.ok && bobRefs.refs.length === 1,
    bobRefs.response,
  );
  const aliceRefs = await refsOf(alice.jwt);
  check(
    "alice's component populate filter on bob's note matches nothing",
    aliceRefs.ok && aliceRefs.refs.length === 0,
    aliceRefs.response,
  );
  const refsSort = await call("GET", "/api/tags?populate[refs][sort]=note.title", alice.jwt);
  check("alice's sort through a component's note is refused", refsSort.status === 400, refsSort);

  // Over HTTP a boolean is a string, read as Strapi reads it.
  const notNone = await list("/api/tags?filters[note][$null]=false", bob.jwt);
  check(
    "bob's $null=false on the note relation finds his tag",
    notNone.ok && notNone.ids.includes(tagId ?? ""),
    notNone.response,
  );
  const notSome = await call("GET", "/api/tags?filters[note][$notNull]=false", alice.jwt);
  check("alice's $notNull=false on the note relation is refused", notSome.status === 400, notSome);

  // A drafter reads the notes no one owns: its scope, `owner IS NULL`, holds on the all-NULL note
  // row Strapi's LEFT JOIN gives a tag with no note, as does a client's $null. A tag with no note
  // must answer as a tag whose note the drafter cannot read.
  const dana = await member(dir, "dana", "drafter");
  for (const query of [
    "filters[note][id][$null]=true",
    "filters[note][title][$null]=true",
    "filters[refs][note][title][$null]=true",
  ]) {
    const r = await list(`/api/tags?${query}`, dana.jwt);
    check(
      `dana's ${query} answers a tag with no note as one with bob's`,
      r.ok && r.ids.includes(idOf(withRefs)) === r.ids.includes(tagId ?? ""),
      r.response,
    );
  }
  // A contributor reads tags but no note: Strapi's own query validation refuses the filter.
  const carol = await member(dir, "carol", "contributor");
  const blind = await call("GET", "/api/tags?filters[note][id][$null]=true", carol.jwt);
  check("carol's filter through a note she cannot read is refused", blind.status === 400, blind);
  // Only the query parameters Strapi documents pass for a restricted caller; the publication
  // cohorts, which test for a version the caller may not read, and an unknown one are refused.
  for (const query of [
    "future=1",
    "publicationFilter=never-published",
    "hasPublishedVersion=true",
    "populate[note][publicationFilter]=has-published-version",
  ]) {
    const r = await call("GET", `/api/tags?${query}`, alice.jwt);
    check(`alice's ${query} is refused`, r.status === 400, r.status);
  }
  const documented = await list(
    "/api/tags?filters[label][$eq]=b&sort=label:asc&fields[0]=label&_q=b&status=published" +
      "&pagination[page]=1&pagination[pageSize]=5&pagination[withCount]=true" +
      "&populate[note][fields][0]=title&populate[note][sort]=title",
    bob.jwt,
  );
  check(
    "bob's list with every documented parameter finds his tag",
    documented.ok && documented.ids.includes(tagId ?? ""),
    documented.response,
  );

  // Strapi's delete reads filters into its where: a relation filter would decide whether alice's
  // own note is deleted, by a guess at bob's. Both guesses are refused alike.
  const throwaway = await call("POST", "/api/notes", alice.jwt, {
    data: { title: "throwaway", shared: false },
  });
  for (const guess of ["bob%27s", "wrong"]) {
    const del = await call(
      "DELETE",
      `/api/notes/${idOf(throwaway)}?filters[pinned][note][title][$eq]=${guess}`,
      alice.jwt,
    );
    check(`alice's delete filtered by a guess (${guess}) is refused`, del.status === 400, del);
  }
  const kept = await call("GET", `/api/notes/${idOf(throwaway)}`, alice.jwt);
  check("alice's note survives both guesses", kept.status === 200, kept);
  const plain = await call("DELETE", `/api/notes/${idOf(throwaway)}`, alice.jwt);
  check("alice deletes her own note", plain.status === 204, plain);
  const updateGuess = await call(
    "PUT",
    `/api/notes/${aliceNote}?filters[pinned][note][title][$eq]=bob%27s`,
    alice.jwt,
    { data: { title: "alice's" } },
  );
  check("alice's update filtered by a guess is refused", updateGuess.status === 400, updateGuess);

  await uploads(dir, alice, bob);

  const link = await call("POST", "/api/tags", alice.jwt, {
    data: { label: "a", note: { connect: [{ documentId: bobNoteId }] } },
  });
  check("alice cannot connect bob's note", link.status === 403, link);
  // The refusal must stop the write, not only answer 403 after it.
  const after = await call("GET", "/api/tags", bob.jwt);
  check(
    "the refused writes created no tag",
    after.status === 200 && !rows(after).some((t) => t.label === "a" || t.label === "a2"),
    after,
  );
};

interface Account {
  jwt: string;
  id: number;
}

/**
 * The upload API for a member, who may upload and delete files: a new file attaches only to an
 * entry the caller may update, a replace or delete needs update on every entry the file is on
 * (or, unattached, that the caller uploaded it), and an entry links only a file the caller
 * uploaded or one on an entry it may read.
 */
const uploads = async (dir: string, alice: Account, bob: Account): Promise<void> => {
  const note = async (who: Account, title: string) => {
    const r = await call("POST", "/api/notes", who.jwt, { data: { title, shared: false } });
    const data = r.body?.data as { id: number; documentId: string } | undefined;
    if (r.status !== 201 || data === undefined)
      throw new Error(`note ${title}: ${JSON.stringify(r)}`);
    return data;
  };
  const files = () => Number(select(dir, "SELECT COUNT(*) AS n FROM files")[0]!.n);
  const attachedTo = (noteId: number) =>
    select(
      dir,
      "SELECT file_id FROM files_related_mph WHERE related_type = 'api::note.note' AND related_id = ?",
      noteId,
    ).map((r) => Number(r.file_id));
  const created = (r: { body: unknown }): number =>
    (r.body as { id: number }[] | null)?.[0]?.id ?? 0;
  const onNote = (id: number) => ({
    ref: "api::note.note",
    refId: String(id),
    field: "attachment",
  });

  const mine = await note(alice, "alice's upload target");
  const theirs = await note(bob, "bob's upload target");

  const own = await send("POST", "/api/upload", alice.jwt, form(onNote(mine.id)));
  check("alice uploads a file to her own note", own.status === 201, own);
  check(
    "the file is attached to alice's note",
    attachedTo(mine.id).includes(created(own)),
    attachedTo(mine.id),
  );
  const uploader = select(dir, "SELECT camis_uploader FROM files WHERE id = ?", created(own));
  check(
    "the file records alice as its uploader",
    uploader[0]?.camis_uploader === alice.id,
    uploader,
  );

  const before = files();
  for (const [what, fields] of [
    ["to bob's note", onNote(theirs.id)],
    ["to a note that does not exist", onNote(999_999)],
    ["to a component's uid", { ref: "shared.reference", refId: "1", field: "image" }],
    ["to a non-media field", { ...onNote(mine.id), field: "title" }],
  ] as const) {
    const r = await send("POST", "/api/upload", alice.jwt, form(fields));
    check(`alice's upload ${what} is 403`, r.status === 403, r);
  }
  for (const [what, fields] of [
    ["with a documentId refId", { ...onNote(mine.id), refId: mine.documentId }],
    ["with a path", { path: "elsewhere" }],
  ] as const) {
    const r = await send("POST", "/api/upload", alice.jwt, form(fields));
    check(`alice's upload ${what} is 400`, r.status === 400, r);
  }
  check("the refused uploads stored no file", files() === before, { before, after: files() });
  check(
    "bob's note has no attachment of alice's",
    attachedTo(theirs.id).length === 0,
    attachedTo(theirs.id),
  );

  const bobs = await send("POST", "/api/upload", bob.jwt, form(onNote(theirs.id)));
  check("bob uploads a file to his own note", bobs.status === 201, bobs);
  const loose = await send("POST", "/api/upload", bob.jwt, form({}));
  check("bob uploads an unattached file", loose.status === 201, loose);
  const fileOfBob = created(bobs);
  const looseOfBob = created(loose);

  const replace = await send("POST", `/api/upload?id=${fileOfBob}`, alice.jwt, form({}));
  check("alice's replace of the file on bob's note is 403", replace.status === 403, replace);
  const info = await send(
    "POST",
    `/api/upload?id=${fileOfBob}`,
    alice.jwt,
    form({ fileInfo: JSON.stringify({ name: "alice's now" }) }, false),
  );
  check("alice's info update of the file on bob's note is 403", info.status === 403, info);
  for (const id of [fileOfBob, looseOfBob]) {
    const del = await send("DELETE", `/api/upload/files/${id}`, alice.jwt);
    check(`alice's delete of bob's file ${id} is 403`, del.status === 403, del);
  }
  check(
    "bob's file is still on his note",
    attachedTo(theirs.id).includes(fileOfBob),
    attachedTo(theirs.id),
  );

  for (const attachment of [looseOfBob, fileOfBob]) {
    const put = await call("PUT", `/api/notes/${mine.documentId}`, alice.jwt, {
      data: { attachment },
    });
    check(`alice cannot attach bob's file ${attachment} to her note`, put.status === 403, put);
    const post = await call("POST", "/api/notes", alice.jwt, {
      data: { title: "with bob's file", shared: false, attachment },
    });
    check(`alice cannot create a note with bob's file ${attachment}`, post.status === 403, post);
  }
  check(
    "alice's note links none of bob's files",
    !attachedTo(mine.id).some((id) => id === fileOfBob || id === looseOfBob),
    attachedTo(mine.id),
  );

  const hers = await send("POST", "/api/upload", alice.jwt, form({}));
  check("alice uploads an unattached file", hers.status === 201, hers);
  const attach = await call("PUT", `/api/notes/${mine.documentId}`, alice.jwt, {
    data: { attachment: created(hers) },
  });
  check("alice attaches her own upload to her note", attach.status === 200, attach);
  const swap = await send("POST", `/api/upload?id=${created(hers)}`, alice.jwt, form({}));
  check("alice replaces the file on her own note", swap.status === 200, swap);
  const drop = await send("DELETE", `/api/upload/files/${created(hers)}`, alice.jwt);
  check("alice deletes the file on her own note", drop.status === 200, drop);
  const tidy = await send("DELETE", `/api/upload/files/${looseOfBob}`, bob.jwt);
  check("bob deletes his own unattached file", tidy.status === 200, tidy);

  // Strapi's database layer spreads an item's __pivot into the join row after the id it links:
  // file_id, related_id or note_id there would name a file or entry no check decided on.
  const links = () => select(dir, "SELECT COUNT(*) AS n FROM files_related_mph")[0]!.n;
  const linksBefore = links();
  const aliceFile = created(own);
  for (const [what, method, path, data] of [
    [
      "a media connect item's __pivot file_id",
      "PUT",
      `/api/notes/${mine.documentId}`,
      { attachment: { connect: [{ id: aliceFile, __pivot: { file_id: fileOfBob } }] } },
    ],
    [
      "a media connect item's __pivot related_id",
      "PUT",
      `/api/notes/${mine.documentId}`,
      { attachment: { connect: [{ id: aliceFile, __pivot: { related_id: theirs.id } }] } },
    ],
    [
      "a media set item's __pivot file_id, on create",
      "POST",
      "/api/notes",
      {
        title: "pivot",
        shared: false,
        attachment: { set: [{ id: aliceFile, __pivot: { file_id: fileOfBob } }] },
      },
    ],
  ] as const) {
    const r = await call(method, path, alice.jwt, { data });
    check(`alice's ${what} is 400`, r.status === 400, r);
  }
  check("the refused media items linked nothing", links() === linksBefore, {
    before: linksBefore,
    after: links(),
  });
  check(
    "bob's file is on no note of alice's",
    !attachedTo(mine.id).includes(fileOfBob),
    attachedTo(mine.id),
  );
  const tagLinks = () => select(dir, "SELECT COUNT(*) AS n FROM tags_note_lnk")[0]!.n;
  const tagLinksBefore = tagLinks();
  const pivotTag = await call("POST", "/api/tags", alice.jwt, {
    data: { label: "pivot", note: { connect: [{ id: mine.id, __pivot: { note_id: theirs.id } }] } },
  });
  check(
    "alice's relation connect item with a __pivot note_id is 400",
    pivotTag.status === 400,
    pivotTag,
  );
  check("the refused relation item linked nothing", tagLinks() === tagLinksBefore, {
    before: tagLinksBefore,
    after: tagLinks(),
  });
  const ownTag = await call("POST", "/api/tags", alice.jwt, {
    data: { label: "plain", note: { connect: [{ id: mine.id }] } },
  });
  check("alice's plain connect item links her note", ownTag.status === 201, ownTag);

  // A reviewer reads every note and updates only its own, and holds no file write grant: Strapi
  // needs none to link a stored file, so reading bob's note must not let it link his file.
  const rita = await member(dir, "rita", "reviewer");
  const ritas = await note(alice, "rita's note");
  run(
    dir,
    "UPDATE notes_owner_lnk SET user_id = ? WHERE note_id IN (SELECT id FROM notes WHERE document_id = ?)",
    rita.id,
    ritas.documentId,
  );
  const borrow = await call("PUT", `/api/notes/${ritas.documentId}`, rita.jwt, {
    data: { attachment: fileOfBob },
  });
  check("rita cannot link bob's file from a note she only reads", borrow.status === 403, borrow);
  const retitle = await call("PUT", `/api/notes/${ritas.documentId}`, rita.jwt, {
    data: { title: "rita's own" },
  });
  check("rita updates her own note", retitle.status === 200, retitle);

  // Rita reads the media library: Strapi returns a file's related entries whole when it can read
  // none of them (bob's note was one), so any populate of them is refused.
  const library = await call("GET", "/api/upload/files", rita.jwt);
  check("rita lists the media library", library.status === 200, library);
  for (const path of [
    "/api/upload/files?populate=related",
    "/api/upload/files?populate=*",
    "/api/upload/files?populate[0]=related.owner",
    `/api/upload/files/${fileOfBob}?populate=related`,
    `/api/upload/files/${fileOfBob}?populate[related][populate]=*`,
    `/api/upload/files/${fileOfBob}?populate[related][on][api::note.note]=true`,
  ]) {
    const r = await call("GET", path, rita.jwt);
    check(`rita's ${path} is 400`, r.status === 400, r);
  }

  // Strapi replaces a relation for any set it finds truthy, one entry included: a set naming only
  // rita's note drops alice's from the category, which rita may not update.
  const category = `category-${Date.now()}`;
  run(
    dir,
    "INSERT INTO categories (document_id, label, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?)",
    category,
    "shared",
    Date.now(),
    Date.now(),
    Date.now(),
  );
  const categoryId = select(dir, "SELECT id FROM categories WHERE document_id = ?", category)[0]!
    .id;
  run(
    dir,
    "INSERT INTO notes_category_lnk (note_id, category_id, note_ord) VALUES (?, ?, 1)",
    mine.id,
    categoryId,
  );
  const held = () =>
    select(dir, "SELECT note_id FROM notes_category_lnk WHERE category_id = ?", categoryId).map(
      (r) => Number(r.note_id),
    );
  for (const [what, set] of [
    ["a set of her note's documentId", ritas.documentId],
    ["a set of her note's row id", ritas.id],
  ] as const) {
    const r = await call("PUT", `/api/categories/${category}`, rita.jwt, {
      data: { notes: { set } },
    });
    check(`rita's ${what} cannot drop alice's note from a category`, r.status === 403, r);
  }
  check(
    "alice's note stays in the category",
    JSON.stringify(held()) === JSON.stringify([mine.id]),
    held(),
  );

  // Strapi's single type controller writes through the same database layer: a restricted
  // caller's __pivot there would name the join row's front_id or category_id.
  const featured = () => select(dir, "SELECT COUNT(*) AS n FROM fronts_featured_lnk")[0]!.n;
  const featuredBefore = featured();
  const pivotFront = await call("PUT", "/api/front", rita.jwt, {
    data: { featured: { connect: [{ id: categoryId, __pivot: { front_id: 999 } }] } },
  });
  check("rita's single type write with a __pivot is 400", pivotFront.status === 400, pivotFront);
  check("the refused single type write linked nothing", featured() === featuredBefore, {
    before: featuredBefore,
    after: featured(),
  });
  const plainFront = await call("PUT", "/api/front", rita.jwt, {
    data: { headline: "welcome", featured: category },
  });
  check("rita's plain single type write is 200", plainFront.status === 200, plainFront);
};

/**
 * Every content API route Strapi registers that a role may reach (one it holds the action of, or
 * one open to anyone) must be in content-api-allowlist.json, which names where it is enforced or
 * why it is safe: a route a new Strapi version, plugin or grant adds fails here until reviewed.
 */
const routeGuard = (dir: string): void => {
  copyFileSync(new URL("./content-api-routes.mjs", import.meta.url), join(dir, "camis-routes.mjs"));
  const run = spawnSync("node", ["camis-routes.mjs"], { cwd: dir, encoding: "utf8" });
  const line = run.stdout.split("\n").find((l) => l.startsWith("CAMIS_ROUTES "));
  if (run.status !== 0 || line === undefined) {
    failures.push(`listing the content API routes failed: ${run.stderr.slice(-2000)}`);
    return;
  }
  const listed = JSON.parse(line.slice("CAMIS_ROUTES ".length)) as {
    routes: ListedRoute[];
    granted: Granted[];
  };
  const allowlist = JSON.parse(
    readFileSync(new URL("./content-api-allowlist.json", import.meta.url), "utf8"),
  ) as Record<string, string>;
  check("Strapi lists content API routes", listed.routes.length > 0, listed.routes.length);
  const problems = routeProblems(listed.routes, listed.granted, allowlist);
  check("every content API route a role can reach is allowlisted", problems.length === 0, problems);
  const holders = new Set(listed.granted.map((g) => g.action));
  const actions = new Set(
    listed.routes.flatMap((r) =>
      [r.handler, ...(r.auth === false || r.auth === null ? [] : (r.auth.scope ?? []))]
        .filter((a): a is string => a !== null)
        .map((a) => (a.includes("::") ? a : `${r.namespace}.${a}`)),
    ),
  );
  for (const action of holders)
    check(`granted action ${action} names a registered route`, actions.has(action), action);
};

/**
 * A role that writes a single type without reading it still reaches what the type links: Strapi's
 * single type controller populates a write's response and links what it is told, unnarrowed. The
 * build must fail for it, before any project boots.
 */
const writerGaps = (): void => {
  const writesFront = {
    ...ownershipBundle,
    roles: ownershipBundle.roles.map((r) =>
      r.name === "member"
        ? { ...r, grants: [...r.grants, { contentType: "Front", actions: ["update" as const] }] }
        : r,
    ),
  };
  const errors = strapiAdapter
    .generate(writesFront, { projectName: "notes" })
    .gaps.gaps.filter((g) => g.severity === "error");
  check(
    "a member that writes the single type without reading it fails the build",
    errors.some(
      (g) =>
        g.feature === "apiRelationReach" &&
        g.location.contentType === "Front" &&
        g.location.rule === "member",
    ),
    errors,
  );
};

/**
 * On an `auth: false` route Strapi strips an ordinary relation from populate but not a polymorphic
 * one, which returns entries of any type: an open action on a type with one fails the build.
 */
const openPolymorphicGaps = (): void => {
  const board = {
    ...ownershipBundle,
    document: {
      ...ownershipBundle.document,
      contentTypes: [
        ...ownershipBundle.document.contentTypes,
        {
          name: "Board",
          kind: "collection" as const,
          options: { publicApiActions: ["list" as const, "read" as const] },
          fields: [{ type: "polymorphicRelation" as const, name: "subjects", many: true }],
        },
      ],
    },
  };
  const errors = strapiAdapter
    .generate(board, { projectName: "notes" })
    .gaps.gaps.filter((g) => g.severity === "error");
  check(
    "an open list of a type with a polymorphic relation fails the build",
    errors.some(
      (g) =>
        g.feature === "apiPolymorphicReach" &&
        g.location.contentType === "Board" &&
        g.location.rule === "public",
    ),
    errors,
  );
};

/**
 * An open route is open whatever roles the IR names, none included; and Strapi keeps a polymorphic
 * list whole when it can read none of its entries, so a role reading one with no condition
 * anywhere fails the build too.
 */
const unconditionedGaps = (): void => {
  const board = (publicApiActions?: ("list" | "read")[]) => ({
    name: "Board",
    kind: "collection" as const,
    ...(publicApiActions === undefined ? {} : { options: { publicApiActions } }),
    fields: [{ type: "polymorphicRelation" as const, name: "subjects", many: true }],
  });
  const noRoles = strapiAdapter.generate(
    {
      document: {
        ...ownershipBundle.document,
        contentTypes: [...ownershipBundle.document.contentTypes, board(["list"])],
      },
      roles: [],
    },
    { projectName: "notes" },
  );
  check(
    "with no roles, an open list of a type with a polymorphic relation fails the build",
    noRoles.gaps.gaps.some(
      (g) =>
        g.severity === "error" &&
        g.feature === "apiPolymorphicReach" &&
        g.location.contentType === "Board",
    ),
    noRoles.gaps.gaps,
  );
  check(
    "with no roles, an open route still has each type leading to a media field served",
    noRoles.files.some(
      (f) =>
        f.path === "src/api/note/controllers/note.ts" && f.content.includes("enforcedController"),
    ),
    noRoles.files.map((f) => f.path),
  );
  const viewer = strapiAdapter.generate(
    {
      document: {
        ...ownershipBundle.document,
        contentTypes: [...ownershipBundle.document.contentTypes, board()],
      },
      roles: [{ name: "viewer", grants: [{ contentType: "Board", actions: ["read"] }] }],
    },
    { projectName: "notes" },
  );
  check(
    "a role reading a type with a polymorphic relation, no condition anywhere, fails the build",
    viewer.gaps.gaps.some(
      (g) =>
        g.severity === "error" &&
        g.feature === "apiPolymorphicReach" &&
        g.location.contentType === "Board" &&
        g.location.rule === "viewer",
    ),
    viewer.gaps.gaps,
  );
};

writerGaps();
openPolymorphicGaps();
unconditionedGaps();
const dir = await mkdtemp(join(tmpdir(), "camis-enforcement-"));
try {
  await materialize(strapiAdapter.generate(ownershipBundle, { projectName: "notes" }), dir);
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: dir,
    stdio: "inherit",
  });
  if (install.status !== 0) {
    console.error(`npm install failed with exit code ${install.status}`);
    process.exit(1);
  }
  // Its own process group, so teardown reaches Strapi's forked worker and Vite.
  const proc: ChildProcess = spawn("npm", ["run", "develop"], {
    cwd: dir,
    stdio: "inherit",
    detached: true,
    env: { ...process.env, BROWSER: "none" },
  });
  try {
    if (!(await pollUntilUp(180_000))) failures.push("Strapi did not answer GET /api/notes");
    else await scenario(dir);
  } catch (error) {
    failures.push(String(error));
  } finally {
    await stopProcessGroup(proc);
  }
  routeGuard(dir);
} finally {
  await rm(dir, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(`ENFORCEMENT SMOKE FAIL:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("ENFORCEMENT SMOKE PASS");
