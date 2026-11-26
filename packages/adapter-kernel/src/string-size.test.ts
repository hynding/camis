import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import {
  INDEXED_STRING_LENGTH,
  STRING_LENGTH,
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

  // A text column cannot be indexed whole, and an index key holds 3,072 bytes: 768 characters at
  // up to four bytes each.
  it("keeps a unique string a string column, no longer than an index key holds", () => {
    expect(INDEXED_STRING_LENGTH).toBe(768);
    expect(stringColumn(string(256, true))).toEqual({ kind: "string", length: 256 });
    expect(stringColumn(string(768, true))).toEqual({ kind: "string", length: 768 });
    expect(stringColumn(string(769, true))).toEqual({ kind: "string", length: 768 });
  });

  it("sizes an email and a uid as a string", () => {
    expect(stringColumn(string(1000, undefined, "email"))).toEqual({ kind: "text", tier: "small" });
    expect(stringColumn(string(1000, true, "uid"))).toEqual({ kind: "string", length: 768 });
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
          { type: "string", name: "slug", unique: true, maxLength: 768 },
          { type: "uid", name: "key", unique: true, maxLength: 769 },
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
        maxLength: 769,
        column: { kind: "string", length: 768 },
      },
      {
        location: { contentType: "Note", field: "huge" },
        maxLength: 1_073_741_824,
        column: { kind: "text", tier: "large" },
      },
      {
        location: { component: "Part", field: "code" },
        maxLength: 1000,
        column: { kind: "string", length: 768 },
      },
    ]);
  });
});
