import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { privateFieldGaps } from "./private-fields";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Review",
      kind: "collection",
      fields: [
        { type: "string", name: "title" },
        { type: "text", name: "moderatorNote", private: true },
      ],
    },
  ],
  components: [{ name: "Score", fields: [{ type: "string", name: "reason", private: true }] }],
};

describe("privateFieldGaps", () => {
  it("reports each private field a target would answer with, naming where it is", () => {
    const gaps = privateFieldGaps(doc, "the Express target");
    expect(gaps.map((g) => [g.feature, g.location])).toEqual([
      ["privateField", { contentType: "Review", field: "moderatorNote" }],
      ["privateField", { component: "Score", field: "reason" }],
    ]);
    expect(gaps[0]!.message).toBe(
      '"moderatorNote" is private; the Express target answers with it like any other field',
    );
  });

  it("reports nothing for a document without private fields", () => {
    expect(
      privateFieldGaps(
        {
          version: 1,
          contentTypes: [
            { name: "Tag", kind: "collection", fields: [{ type: "string", name: "label" }] },
          ],
          components: [],
        },
        "the Express target",
      ),
    ).toEqual([]);
  });
});
