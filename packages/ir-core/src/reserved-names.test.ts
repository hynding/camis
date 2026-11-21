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
        location: { contentType: "Person", field: "stamped" },
        severity: "error",
        message: `inverse "stamped" of relation "Note.owner" collides with the Test target's own "stamped"; rename it`,
      },
      {
        feature: "reservedFieldName",
        location: { component: "Seo", field: "stampedAt" },
        severity: "error",
        message: `field "stampedAt" collides with the Test target's own "stampedAt"; rename it`,
      },
    ]);
  });

  it("leaves a built-in type alone by default: the target owns its fields", () => {
    const gaps = reservedNameGaps(doc, "the Test target", RESERVED, snakeNames);
    expect(gaps.some((g) => g.location.contentType === "User")).toBe(false);
  });

  it("walks a built-in type for a target that emits its fields as any type's", () => {
    const gaps = reservedNameGaps(doc, "the Test target", RESERVED, snakeNames, {
      builtins: true,
    });
    expect(gaps.filter((g) => g.location.contentType === "User")).toEqual([
      {
        feature: "reservedFieldName",
        location: { contentType: "User", field: "stampedAt" },
        severity: "error",
        message: `field "stampedAt" collides with the Test target's own "stampedAt"; rename it`,
      },
    ]);
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

  it("reports a field once per name the target keeps, though two kept spellings name it", () => {
    const aliased = new Map([
      ["stamped_at", "stampedAt"],
      ["stamped_at_id", "stampedAt"],
    ]);
    const gaps = reservedNameGaps(doc, "the Test target", aliased, (field, holder) =>
      holder === "contentType" && field.name === "stampedAt"
        ? [
            { spelled: "stampedAt", mapped: "stamped_at" },
            { spelled: "stamped_at_id", mapped: "stamped_at_id" },
          ]
        : [],
    );
    expect(gaps.map((g) => g.message)).toEqual([
      `field "stampedAt" collides with the Test target's own "stampedAt"; rename it`,
    ]);
  });

  // Renaming the field leaves its inverse's collision on Person, so each is reported where it is.
  it("reports a relation and its inverse kept under one name each where it lands", () => {
    const related: IrDocument = {
      version: 1,
      contentTypes: [
        {
          name: "Note",
          kind: "collection",
          fields: [
            {
              type: "relation",
              name: "stamped",
              relationKind: "manyToOne",
              target: "Person",
              inverse: "stamped",
            },
          ],
        },
        { name: "Person", kind: "collection", fields: [{ type: "string", name: "name" }] },
      ],
      components: [],
    };
    const gaps = reservedNameGaps(related, "the Test target", RESERVED, snakeNames);
    expect(gaps.map((g) => [g.location, g.message])).toEqual([
      [
        { contentType: "Note", field: "stamped" },
        `field "stamped" collides with the Test target's own "stamped"; rename it`,
      ],
      [
        { contentType: "Person", field: "stamped" },
        `inverse "stamped" of relation "Note.stamped" collides with the Test target's own "stamped"; rename it`,
      ],
    ]);
  });
});

describe("reservedNameGaps, embedded components", () => {
  // Note.created embeds Stamp, whose `at` and nested `by.at` land on Note's own row; `items` and
  // `zone` are rows of tables of their own, so nothing under them is embedded in Note.
  const embedding: IrDocument = {
    version: 1,
    contentTypes: [
      {
        name: "Note",
        kind: "collection",
        fields: [
          { type: "component", name: "created", component: "Stamp", repeatable: false },
          { type: "component", name: "items", component: "Stamp", repeatable: true },
          { type: "dynamicZone", name: "zone", components: ["Stamp"] },
        ],
      },
    ],
    components: [
      {
        name: "Stamp",
        fields: [
          { type: "dateTime", name: "at" },
          { type: "component", name: "by", component: "Mark", repeatable: false },
          { type: "component", name: "marks", component: "Mark", repeatable: true },
        ],
      },
      { name: "Mark", fields: [{ type: "dateTime", name: "at" }] },
    ],
  };

  const KEPT = new Map([
    ["created_at", "createdAt"],
    ["created_by_at", "createdByAt"],
    ["by_at", "byAt"],
  ]);

  const nothingOwn = (): TargetName[] => [];
  const joined = (path: readonly string[]): TargetName[] => {
    const column = path.map(snakeCase).join("_");
    return [{ spelled: column, mapped: column }];
  };

  it("reports a field of an embedded component whose path the target keeps, located", () => {
    const gaps = reservedNameGaps(embedding, "the Test target", KEPT, nothingOwn, {
      columns: joined,
    });
    expect(gaps).toEqual([
      {
        feature: "reservedFieldName",
        location: { contentType: "Note", component: "Stamp", field: "at" },
        severity: "error",
        message: `field "at" of component "Stamp", embedded in "Note.created" as "created_at", collides with the Test target's own "createdAt"; rename it`,
      },
      {
        feature: "reservedFieldName",
        location: { contentType: "Note", component: "Mark", field: "at" },
        severity: "error",
        message: `field "at" of component "Mark", embedded in "Note.created.by" as "created_by_at", collides with the Test target's own "createdByAt"; rename it`,
      },
    ]);
  });

  // Stamp is only embedded unless the target says it stores Stamp's items: `by.at` is then no
  // column of any row (on Note's it is created_by_at).
  it("checks a component's paths from no row of its own unless the target stores its items", () => {
    const gaps = reservedNameGaps(embedding, "the Test target", KEPT, nothingOwn, {
      columns: joined,
    });
    expect(gaps.some((g) => g.location.contentType === undefined)).toBe(false);
  });

  // The item's own fields and its embedded components' land on the item's row, the path
  // restarting there, and are checked against what that row keeps.
  const ITEM_KEPT = new Map([
    ["at", "at"],
    ["by_at", "byAt"],
  ]);
  const stampItems = (heldBy: string) => ({ component: "Stamp", heldBy, kept: ITEM_KEPT });

  it("checks an item's fields, its embedded components' included, on its item table", () => {
    const gaps = reservedNameGaps(embedding, "the Test target", KEPT, nothingOwn, {
      columns: joined,
      items: [stampItems("Note.items")],
    });
    expect(gaps.filter((g) => g.location.contentType === undefined)).toEqual([
      {
        feature: "reservedFieldName",
        location: { component: "Stamp", field: "at" },
        severity: "error",
        message: `field "at" of component "Stamp", in "Note.items" as "at", collides with the Test target's own "at"; rename it`,
      },
      {
        feature: "reservedFieldName",
        location: { component: "Mark", field: "at" },
        severity: "error",
        message: `field "at" of component "Mark", embedded in "Stamp.by" as "by_at", collides with the Test target's own "byAt"; rename it`,
      },
    ]);
  });

  it("checks an item's columns against its table's names, not the entry's", () => {
    const gaps = reservedNameGaps(embedding, "the Test target", ITEM_KEPT, nothingOwn, {
      columns: joined,
      items: [{ component: "Stamp", heldBy: "Note.items", kept: new Map() }],
    });
    expect(gaps).toEqual([]);
  });

  it("reports an item's field once though two item tables keep its column", () => {
    const gaps = reservedNameGaps(embedding, "the Test target", KEPT, nothingOwn, {
      columns: joined,
      items: [stampItems("Note.items"), stampItems("Note.zone")],
    });
    expect(gaps.filter((g) => g.location.contentType === undefined)).toHaveLength(2);
  });

  it("hands the target each column with its path from its row", () => {
    const seen: string[] = [];
    reservedNameGaps(embedding, "the Test target", KEPT, nothingOwn, {
      columns: (path, field) => {
        seen.push(`${path.join(".")}:${field.type}`);
        return [];
      },
      items: [stampItems("Note.items")],
    });
    expect(seen).toEqual([
      "created.at:dateTime",
      "created.by.at:dateTime",
      "at:dateTime",
      "by.at:dateTime",
    ]);
  });

  it("checks no column for a target that names none", () => {
    expect(
      reservedNameGaps(embedding, "the Test target", KEPT, nothingOwn, {
        items: [stampItems("Note.items")],
      }),
    ).toEqual([]);
  });
});
