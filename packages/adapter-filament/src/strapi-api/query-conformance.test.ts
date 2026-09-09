import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Expression } from "@camis/expr";
import { evaluate } from "@camis/expr-ts";
import { renderSql, toWhereNode, whereContext } from "./query-ast";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { storageBundle } from "./storage/__fixtures__/storage";

const hasPhp = (): boolean => {
  try {
    execFileSync("php", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const activity = strapiApiBundle.document.contentTypes.find((c) => c.name === "Activity")!;
const ctx = whereContext(activity);
const v = (name: string): Expression => ({ kind: "var", name });
const lit = (value: string | number | boolean | null): Expression => ({ kind: "lit", value });

type Row = {
  id: number;
  name: string | null;
  visibility: string | null;
  creator_id: number | null;
};
const rows: Row[] = [
  { id: 1, name: "run", visibility: "public", creator_id: 1 },
  { id: 2, name: "swim", visibility: "private", creator_id: 1 },
  { id: 3, name: "bike", visibility: "private", creator_id: 2 },
  { id: 4, name: null, visibility: null, creator_id: null },
  { id: 5, name: "row", visibility: "public", creator_id: null },
];
const USER = 1;

const cases: { name: string; expr: Expression }[] = [
  {
    name: "public or mine",
    expr: {
      kind: "or",
      args: [
        { kind: "eq", left: v("record.visibility"), right: lit("public") },
        { kind: "eq", left: v("record.creatorId"), right: v("user.id") },
      ],
    },
  },
  { name: "mine", expr: { kind: "eq", left: v("record.creatorId"), right: v("user.id") } },
  { name: "name is null", expr: { kind: "eq", left: v("record.name"), right: lit(null) } },
  {
    name: "and",
    expr: {
      kind: "and",
      args: [
        { kind: "eq", left: v("record.visibility"), right: lit("private") },
        { kind: "eq", left: v("record.creatorId"), right: v("user.id") },
      ],
    },
  },
];

const expectedIds = (expr: Expression): number[] =>
  rows
    .filter((r) => {
      const res = evaluate(expr, {
        "record.name": r.name,
        "record.visibility": r.visibility,
        "record.creatorId": r.creator_id,
        "user.id": USER,
      });
      return res.ok && res.value === true;
    })
    .map((r) => r.id);

describe("query-ast SQLite conformance", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "query-conf-"));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasPhp())(
    "SQL rendering selects exactly the rows the Ring 1 evaluator accepts",
    () => {
      for (const c of cases) {
        const node = toWhereNode(c.expr, ctx);
        expect(node, c.name).not.toBeNull();
        const where = renderSql(node!, USER);
        const inserts = rows
          .map(
            (r) =>
              `INSERT INTO t VALUES (${r.id}, ${r.name === null ? "NULL" : `'${r.name}'`}, ${
                r.visibility === null ? "NULL" : `'${r.visibility}'`
              }, ${r.creator_id === null ? "NULL" : r.creator_id});`,
          )
          .join(" ");
        const php = `<?php $db = new PDO('sqlite::memory:'); $db->exec("CREATE TABLE t (id INTEGER, name TEXT, visibility TEXT, creator_id INTEGER); ${inserts}"); echo json_encode(array_map('intval', $db->query("SELECT id FROM t WHERE ${where} ORDER BY id")->fetchAll(PDO::FETCH_COLUMN)));`;
        const file = join(dir, "q.php");
        writeFileSync(file, php);
        const got = JSON.parse(execFileSync("php", [file], { encoding: "utf8" })) as number[];
        expect(got, c.name).toEqual(expectedIds(c.expr));
      }
    },
  );
});

// The strapi layout renders an owning relation as an EXISTS subquery against its link table
// rather than a plain FK column, so it needs its own table pair (notes + notes_owner_lnk) instead
// of the single-table `activities` fixture above.
describe("query-ast SQLite conformance (strapi link tables)", () => {
  const note = storageBundle.document.contentTypes.find((c) => c.name === "Note")!;
  const noteCtx = whereContext(note, "strapi");
  const OWNER = 7;

  type NoteRow = { id: number; text: string };
  const noteRows: NoteRow[] = [
    { id: 1, text: "a" },
    { id: 2, text: "b" },
    { id: 3, text: "c" },
  ];
  // Note 1 has two link rows for the same owner (must still count once, via EXISTS); note 2 is
  // linked to a different user; note 3 has no link row at all (excluded from "mine").
  const links: { note_id: number; user_id: number }[] = [
    { note_id: 1, user_id: OWNER },
    { note_id: 1, user_id: OWNER },
    { note_id: 2, user_id: 9 },
  ];
  // The TS evaluator has no notion of a link table, so `record.ownerId` is derived here from the
  // first link row for that note (null when there is none) to keep both sides of the vector honest.
  const ownerIdOf = (noteId: number): number | null =>
    links.find((l) => l.note_id === noteId)?.user_id ?? null;

  const noteCases: { name: string; expr: Expression }[] = [
    {
      name: "mine (via link table)",
      expr: { kind: "eq", left: v("record.ownerId"), right: v("user.id") },
    },
    {
      name: "unowned (no link row)",
      expr: { kind: "eq", left: v("record.ownerId"), right: lit(null) },
    },
    {
      name: "or: scalar predicate combined with a link predicate",
      expr: {
        kind: "or",
        args: [
          { kind: "eq", left: v("record.text"), right: lit("b") },
          { kind: "eq", left: v("record.ownerId"), right: v("user.id") },
        ],
      },
    },
  ];

  const expectedNoteIds = (expr: Expression): number[] =>
    noteRows
      .filter((r) => {
        const res = evaluate(expr, {
          "record.text": r.text,
          "record.ownerId": ownerIdOf(r.id),
          "user.id": OWNER,
        });
        return res.ok && res.value === true;
      })
      .map((r) => r.id);

  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "query-conf-link-"));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasPhp())(
    "EXISTS-subquery rendering over a link table selects exactly the rows the Ring 1 evaluator accepts",
    () => {
      for (const c of noteCases) {
        const node = toWhereNode(c.expr, noteCtx);
        expect(node, c.name).not.toBeNull();
        const where = renderSql(node!, OWNER);
        const noteInserts = noteRows
          .map((r) => `INSERT INTO notes VALUES (${r.id}, '${r.text}');`)
          .join(" ");
        const linkInserts = links
          .map((l) => `INSERT INTO notes_owner_lnk VALUES (${l.note_id}, ${l.user_id});`)
          .join(" ");
        const php = `<?php $db = new PDO('sqlite::memory:'); $db->exec("CREATE TABLE notes (id INTEGER, text TEXT); CREATE TABLE notes_owner_lnk (note_id INTEGER, user_id INTEGER); ${noteInserts} ${linkInserts}"); echo json_encode(array_map('intval', $db->query("SELECT id FROM notes WHERE ${where} ORDER BY id")->fetchAll(PDO::FETCH_COLUMN)));`;
        const file = join(dir, "q.php");
        writeFileSync(file, php);
        const got = JSON.parse(execFileSync("php", [file], { encoding: "utf8" })) as number[];
        expect(got, c.name).toEqual(expectedNoteIds(c.expr));
      }
    },
  );
});
