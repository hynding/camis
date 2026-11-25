import { describe, expect, it } from "vitest";
import type { Field, IrDocument } from "@camis/ir-schema";
import { textsBeyondTiers, textTier } from "./text-size";

const text = (maxLength?: number): Field =>
  ({ type: "text", name: "body", ...(maxLength === undefined ? {} : { maxLength }) }) as Field;

describe("textTier", () => {
  it("is large for a text with no bound, as Strapi's is", () => {
    expect(textTier(text())).toBe("large");
  });

  // 65,535, 16,777,215 and 4,294,967,295 bytes, at up to 4 bytes a character.
  it.each([
    [1, "small"],
    [16_383, "small"],
    [16_384, "medium"],
    [4_194_303, "medium"],
    [4_194_304, "large"],
    [524_288, "medium"],
    [1_073_741_823, "large"],
  ] as const)("holds a bound of %i characters in the %s tier", (maxLength, tier) => {
    expect(textTier(text(maxLength))).toBe(tier);
  });

  it("makes rich text large whatever its bound", () => {
    expect(textTier({ type: "richText", name: "body", maxLength: 100 } as Field)).toBe("large");
  });
});

describe("textsBeyondTiers", () => {
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

  it("lists the texts with a bound the large tier cannot hold, a component's included", () => {
    expect(textsBeyondTiers(doc)).toEqual([
      { location: { contentType: "Note", field: "huge" }, maxLength: 1_073_741_824 },
      { location: { component: "Part", field: "all" }, maxLength: 2_000_000_000 },
    ]);
  });
});
