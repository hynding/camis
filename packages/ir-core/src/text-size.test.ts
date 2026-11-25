import { describe, expect, it } from "vitest";
import type { Field, IrDocument } from "@camis/ir-schema";
import { textColumnSize, textsBeyondColumn } from "./text-size";

const text = (maxLength?: number): Field =>
  ({ type: "text", name: "body", ...(maxLength === undefined ? {} : { maxLength }) }) as Field;

describe("textColumnSize", () => {
  it("is longtext for a text with no bound, as Strapi's is", () => {
    expect(textColumnSize(text())).toBe("longText");
  });

  // MySQL's TEXT holds 65,535 bytes, MEDIUMTEXT 16,777,215 and LONGTEXT 4,294,967,295; a character
  // takes up to 4 bytes of utf8mb4.
  it.each([
    [1, "text"],
    [16_383, "text"],
    [16_384, "mediumText"],
    [4_194_303, "mediumText"],
    [4_194_304, "longText"],
    [524_288, "mediumText"],
    [1_073_741_823, "longText"],
  ] as const)("holds a bound of %i characters in %s", (maxLength, size) => {
    expect(textColumnSize(text(maxLength))).toBe(size);
  });

  it("sizes a rich text the same way", () => {
    expect(textColumnSize({ type: "richText", name: "body", maxLength: 100 } as Field)).toBe(
      "text",
    );
  });
});

describe("textsBeyondColumn", () => {
  const doc = {
    version: 1,
    contentTypes: [
      {
        name: "Note",
        kind: "collection",
        fields: [
          text(1_073_741_823),
          { type: "text", name: "huge", maxLength: 1_073_741_824 },
          { type: "string", name: "title", maxLength: 2_000_000_000 },
        ],
      },
    ],
    components: [
      { name: "Part", fields: [{ type: "richText", name: "all", maxLength: 2_000_000_000 }] },
    ],
  } as IrDocument;

  it("lists the texts a bound too large for LONGTEXT, a component's included", () => {
    expect(textsBeyondColumn(doc)).toEqual([
      { location: { contentType: "Note", field: "huge" }, maxLength: 1_073_741_824 },
      { location: { component: "Part", field: "all" }, maxLength: 2_000_000_000 },
    ]);
  });
});
