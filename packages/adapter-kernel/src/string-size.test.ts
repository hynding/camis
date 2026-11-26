import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import {
  INDEXED_STRING_LENGTH,
  STRING_LENGTH,
  enforcedLength,
  holdsTextColumn,
  stringColumn,
  stringsBeyondColumns,
} from "./string-size";

type StringLike = Parameters<typeof stringColumn>[0];

const string = (maxLength?: number, unique?: boolean, type = "string"): StringLike =>
  ({
    type,
    name: "title",
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(unique === undefined ? {} : { unique }),
  }) as StringLike;

describe("stringColumn (issue #126)", () => {
  it("is a string column of the target's own length without a bound", () => {
    expect(stringColumn(string())).toEqual({ kind: "string" });
    expect(stringColumn(string(undefined, true))).toEqual({ kind: "string" });
  });

  // An unbounded string's column is 255 characters long on every target; no bounded string's own
  // column is wider, so a table holds as many as it holds unbounded ones.
  it.each([1, 100, STRING_LENGTH])("is a string column of a bound of %i characters", (bound) => {
    expect(stringColumn(string(bound))).toEqual({ kind: "string", length: bound });
  });

  it.each([
    [256, "small"],
    [16_383, "small"],
    [16_384, "medium"],
    [4_194_304, "large"],
    [2_000_000_000, "large"],
  ] as const)("is a text column of the tier holding a longer bound (%i: %s)", (maxLength, tier) => {
    expect(stringColumn(string(maxLength))).toEqual({ kind: "text", tier });
  });

  // A text column cannot be indexed whole, and PostgreSQL's btree entry holds 2,704 bytes (MySQL's
  // index key 3,072): 676 characters at up to four bytes each.
  it("keeps a unique string a string column, no longer than an index entry holds", () => {
    expect(INDEXED_STRING_LENGTH).toBe(676);
    expect(stringColumn(string(256, true))).toEqual({ kind: "string", length: 256 });
    expect(stringColumn(string(676, true))).toEqual({ kind: "string", length: 676 });
    expect(stringColumn(string(677, true))).toEqual({ kind: "string", length: 676 });
  });

  it("sizes an email and a uid as a string", () => {
    expect(stringColumn(string(1000, undefined, "email"))).toEqual({ kind: "text", tier: "small" });
    expect(stringColumn(string(1000, true, "uid"))).toEqual({ kind: "string", length: 676 });
  });
});

// A write path checks what the column holds, so a value past a capped column is refused as invalid
// rather than failing in the database.
describe("enforcedLength", () => {
  it("is the bound where the column holds it, the column's length where it is capped", () => {
    expect(enforcedLength(string())).toBeUndefined();
    expect(enforcedLength(string(40))).toBe(40);
    expect(enforcedLength(string(20_000))).toBe(20_000);
    expect(enforcedLength(string(676, true))).toBe(676);
    expect(enforcedLength(string(1000, true))).toBe(676);
  });
});

// MySQL takes no literal default on a TEXT column (ER_BLOB_CANT_HAVE_DEFAULT).
describe("holdsTextColumn", () => {
  it("is true for a text, a rich text and a string bounded past a string column", () => {
    expect(holdsTextColumn({ type: "text", name: "a" } as never)).toBe(true);
    expect(holdsTextColumn({ type: "richText", name: "a" } as never)).toBe(true);
    expect(holdsTextColumn({ type: "string", name: "a", maxLength: 256 } as never)).toBe(true);
    expect(holdsTextColumn({ type: "string", name: "a", maxLength: 255 } as never)).toBe(false);
    expect(holdsTextColumn({ type: "uid", name: "a", maxLength: 900, unique: true } as never)).toBe(
      false,
    );
    expect(holdsTextColumn({ type: "integer", name: "a" } as never)).toBe(false);
  });
});

describe("stringsBeyondColumns", () => {
  const doc = {
    version: 1,
    contentTypes: [
      {
        name: "Note",
        kind: "collection",
        fields: [
          { type: "string", name: "slug", unique: true, maxLength: 676 },
          { type: "uid", name: "key", unique: true, maxLength: 677 },
          { type: "string", name: "body", maxLength: 1_073_741_823 },
          { type: "email", name: "huge", maxLength: 1_073_741_824 },
          { type: "text", name: "notes", maxLength: 2_000_000_000 },
        ],
      },
    ],
    components: [
      { name: "Part", fields: [{ type: "string", name: "code", unique: true, maxLength: 1000 }] },
    ],
  } as IrDocument;

  it("lists, located, each string whose column cannot hold its bound, a component's included", () => {
    expect(stringsBeyondColumns(doc)).toEqual([
      {
        location: { contentType: "Note", field: "key" },
        maxLength: 677,
        column: { kind: "string", length: 676 },
      },
      {
        location: { contentType: "Note", field: "huge" },
        maxLength: 1_073_741_824,
        column: { kind: "text", tier: "large" },
      },
      {
        location: { component: "Part", field: "code" },
        maxLength: 1000,
        column: { kind: "string", length: 676 },
      },
    ]);
  });
});
