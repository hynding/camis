// Boots the polymorphic-links fixture (secured) and drives its links over HTTP: a note links a book
// and a film and is pinned to a book, both read back as { type, id }; a book and a film read the
// notes linking them; a link to an entry the caller may not read, or that is not there, is refused
// on write and left out on read. boot-smoke.ts runs it on every leg; run alone with
// `tsx scripts/morph-smoke.ts [dialect]`.
import { pathToFileURL } from "node:url";
import type { Dialect } from "../src/dialect";
import { morphs } from "../src/__fixtures__/morphs";
import { fail, smokeProject, waitForServer } from "./smoke-project";

const same = (actual: unknown, expected: unknown, what: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

export const morphSmoke = async (dialect: Dialect = "sqlite", port = 3212): Promise<void> => {
  const project = await smokeProject(morphs, dialect, "morphs", port);
  try {
    project.start();
    const base = `http://127.0.0.1:${port}`;
    await waitForServer(`${base}/api/books`);
    const login = async (email: string): Promise<string> => {
      const res = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "dev" }),
      });
      if (res.status !== 200) fail(`login ${email} → ${res.status}`);
      return ((await res.json()) as { token: string }).token;
    };
    const planner = await login("planner@example.com");
    const keeper = await login("keeper@example.com");
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}/api/${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const make = async (token: string, path: string, title: string): Promise<number> => {
      const made = await call(token, "POST", path, { title });
      if (made.status !== 201) fail(`create ${path} → ${made.status}`);
      return made.body.id as number;
    };

    const dune = await make(planner, "books", "Dune");
    const heat = await make(planner, "films", "Heat");
    const vault = await make(keeper, "secrets", "Vault");

    const note = await call(planner, "POST", "notes", {
      title: "n1",
      subjects: [
        { type: "Book", id: dune },
        { type: "Film", id: heat },
        { type: "Book", id: dune },
      ],
      pinned_to: { type: "Book", id: dune },
    });
    same(note.status, 201, "note create");
    same(
      note.body.subjects,
      [
        { type: "Book", id: dune },
        { type: "Film", id: heat },
      ],
      "subjects (deduped, in order)",
    );
    same(note.body.pinned_to, { type: "Book", id: dune }, "pinned_to");
    same("pinned_to_id" in note.body, false, "the to-one's columns stay off the body");
    const id = note.body.id as number;

    same((await call(planner, "GET", `books/${dune}`)).body.pins, [id], "a book's pins");
    same((await call(planner, "GET", `books/${dune}`)).body.remarks, [id], "a book's remarks");
    same((await call(planner, "GET", `films/${heat}`)).body.pin, null, "a film's pin");

    // Refused: a type the caller may not read, an entry that is not there, a malformed link.
    for (const body of [
      { subjects: [{ type: "Secret", id: vault }] },
      { subjects: [{ type: "Book", id: 999 }] },
      { subjects: [{ type: "Book", id: 99_999_999_999 }] },
      { pinned_to: { type: "Nope", id: dune } },
      { subjects: { type: "Book", id: dune } },
    ]) {
      same((await call(planner, "PATCH", `notes/${id}`, body)).status, 400, JSON.stringify(body));
    }

    // A link replaced; the to-one moved to the film, which now reads it.
    const moved = await call(planner, "PATCH", `notes/${id}`, {
      subjects: [{ type: "Film", id: heat }],
      pinned_to: { type: "Film", id: heat },
    });
    same(moved.body.subjects, [{ type: "Film", id: heat }], "subjects replaced");
    same((await call(planner, "GET", `films/${heat}`)).body.pin, id, "the film's pin");
    same((await call(planner, "GET", `books/${dune}`)).body.remarks, [], "the book's remarks");

    // The keeper's note links a secret and a book; the planner, who may not read secrets, sees the book.
    const kept = await call(keeper, "POST", "notes", {
      title: "k",
      subjects: [
        { type: "Secret", id: vault },
        { type: "Book", id: dune },
      ],
    });
    same(
      kept.body.subjects,
      [
        { type: "Secret", id: vault },
        { type: "Book", id: dune },
      ],
      "the keeper's links",
    );
    const seen = await call(planner, "GET", `notes/${kept.body.id as number}`);
    same(seen.body.subjects, [{ type: "Book", id: dune }], "the planner's view of them");

    // More concurrent link writes than a database pool holds (10): creates, updates of distinct
    // notes and updates of one note, each a transaction. Every one answers, none with a 500, and
    // the API answers afterwards.
    const timed = async (method: string, path: string, body: unknown) => {
      const res = await fetch(`${base}/api/${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${planner}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const links = [
      { type: "Book", id: dune },
      { type: "Film", id: heat },
    ];
    const created = await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        timed("POST", "notes", { title: `c${i}`, subjects: links.slice(i % 2) }),
      ),
    );
    same(
      created.map((r) => r.status),
      Array<number>(16).fill(201),
      "concurrent creates",
    );
    const ids = created.map((r) => r.body.id as number);
    const updated = await Promise.all([
      ...ids.map((each, i) =>
        timed("PATCH", `notes/${each}`, { subjects: links.slice((i + 1) % 2) }),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        timed("PATCH", `notes/${ids[0]}`, { subjects: links.slice(i % 2) }),
      ),
    ]);
    same(
      updated.map((r) => r.status),
      Array<number>(24).fill(200),
      "concurrent updates",
    );
    same((await call(planner, "GET", `notes/${ids[1]}`)).status, 200, "a read after them");
    console.log(`CONCURRENT LINK WRITES OK (${dialect})`);

    // Deleting a note takes its links with it.
    same((await call(planner, "DELETE", `notes/${id}`)).status, 200, "note delete");
    same(
      (await call(planner, "GET", `films/${heat}`)).body.pin,
      null,
      "the film's pin after delete",
    );
    console.log(`EXPRESS MORPH LINKS OK (${dialect})`);
  } finally {
    await project.stop();
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  await morphSmoke((process.argv[2] ?? "sqlite") as Dialect);
