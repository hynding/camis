import { describe, expect, it } from "vitest";
import type { IrDocument } from "@camis/ir-schema";
import { reservedNameGaps, type TargetName } from "./reserved-names";
import { snakeCase } from "./inflect";

const doc: IrDocument = {
  version: 1,
  contentTypes: [
    {
      name: "Note",
      kind: "collection",
      fields: [
        { type: "string", name: "title" },
        { type: "dateTime", name: "stampedAt" },
        {
          type: "relation",
          name: "owner",
          relationKind: "manyToOne",
          target: "Person",
          inverse: "stamped",
        },
      ],
    },
    { name: "Person", kind: "collection", fields: [{ type: "string", name: "name" }] },
    {
      name: "User",
      kind: "collection",
      builtin: "user",
      fields: [{ type: "string", name: "stampedAt" }],
    },
  ],
  components: [{ name: "Seo", fields: [{ type: "string", name: "stampedAt" }] }],
};

const RESERVED = new Map([
  ["stamped_at", "stampedAt"],
  ["stamped", "stamped"],
]);

const snakeNames = (field: { name: string; inverse?: string | undefined }): TargetName[] => [
  { spelled: field.name, mapped: snakeCase(field.name) },
  ...(field.inverse !== undefined
    ? [{ spelled: field.inverse, mapped: snakeCase(field.inverse), inverse: true as const }]
    : []),
];

describe("reservedNameGaps", () => {
  it("reports each field and inverse whose mapped name the target reserves, located", () => {
    const gaps = reservedNameGaps(doc, "the Test target", RESERVED, snakeNames);
    expect(gaps).toEqual([
      {
        feature: "reservedFieldName",
        location: { contentType: "Note", field: "stampedAt" },
        severity: "error",
        message: `field "stampedAt" collides with the Test target's own "stampedAt"; rename it`,
      },
      {
        feature: "reservedFieldName",
        location: { contentType: "Note", field: "owner" },
        severity: "error",
        message: `inverse "stamped" of relation "owner" collides with the Test target's own "stamped"; rename it`,
      },
      {
        feature: "reservedFieldName",
        location: { component: "Seo", field: "stampedAt" },
        severity: "error",
        message: `field "stampedAt" collides with the Test target's own "stampedAt"; rename it`,
      },
    ]);
  });

  it("leaves a built-in type alone: the target owns its fields", () => {
    const gaps = reservedNameGaps(doc, "the Test target", RESERVED, snakeNames);
    expect(gaps.some((g) => g.location.contentType === "User")).toBe(false);
  });

  it("tells the holder apart, so a target can map a component's fields differently", () => {
    const gaps = reservedNameGaps(doc, "the Test target", RESERVED, (field, holder) =>
      holder === "component" ? [] : snakeNames(field),
    );
    expect(gaps.some((g) => g.location.component !== undefined)).toBe(false);
  });

  it("says what the field is called on the target when that is not its name", () => {
    const gaps = reservedNameGaps(doc, "the Test target", RESERVED, (field, holder) =>
      holder === "contentType" && field.name === "title"
        ? [{ spelled: "stamped_at", mapped: "stamped_at" }]
        : [],
    );
    expect(gaps.map((g) => g.message)).toEqual([
      `field "title", as "stamped_at", collides with the Test target's own "stampedAt"; rename it`,
    ]);
  });

  it("reports a field once per reserved name, however many of its names map onto it", () => {
    const gaps = reservedNameGaps(doc, "the Test target", RESERVED, (field) => [
      ...snakeNames(field),
      ...snakeNames(field),
    ]);
    expect(gaps).toHaveLength(3);
  });
});
