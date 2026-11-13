import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { fieldEditorGaps } from "./field-editors";

describe("fieldEditorGaps", () => {
  it("names each field whose source editor a target shows with its own input", () => {
    const doc = {
      version: 1,
      contentTypes: [
        {
          name: "Film",
          kind: "collection",
          fields: [
            { type: "integer", name: "rating", editor: { name: "plugin::stars.rating" } },
            { type: "string", name: "title" },
          ],
        },
      ],
      components: [
        {
          name: "Review",
          fields: [{ type: "text", name: "body", editor: { name: "global::md" } }],
        },
      ],
    } as IrDocument;
    expect(fieldEditorGaps(doc, "the Filament admin")).toEqual([
      {
        feature: "fieldEditor",
        location: { contentType: "Film", field: "rating" },
        severity: "downgrade",
        message:
          '"rating" was edited with plugin::stars.rating; the Filament admin shows its own integer input',
      },
      {
        feature: "fieldEditor",
        location: { component: "Review", field: "body" },
        severity: "downgrade",
        message: '"body" was edited with global::md; the Filament admin shows its own text input',
      },
    ]);
  });
});
