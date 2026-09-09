import { describe, expect, it } from "vitest";
import { normalize } from "@camis/ir-core";
import type { IrDocument } from "@camis/ir-schema";
import { strapiApiBundle } from "./__fixtures__/strapi-api";
import { wireShape } from "./wire-shape";

const doc = normalize(strapiApiBundle.document);
const ct = (name: string) => doc.contentTypes.find((c) => c.name === name)!;

const nestedDoc: IrDocument = normalize({
  version: 1,
  contentTypes: [
    {
      name: "Consumable",
      kind: "collection",
      fields: [
        { type: "string", name: "recordId", required: true, unique: true },
        { type: "component", name: "facts", component: "Facts", repeatable: false },
      ],
    },
  ],
  components: [
    {
      name: "Facts",
      fields: [
        { type: "decimal", name: "calories" },
        { type: "component", name: "additional", component: "Nutrient", repeatable: true },
      ],
    },
    {
      name: "Nutrient",
      fields: [
        { type: "string", name: "slug" },
        { type: "decimal", name: "amount" },
      ],
    },
  ],
});

describe("wireShape", () => {
  it("maps top-level scalars, skips relations, uses upsertBy as key column", () => {
    const s = wireShape(doc, ct("Note"), ["owner_id"]);
    expect(s.model).toBe("Note");
    expect(s.keyColumn).toBe("record_id");
    expect(s.scalars.map((x) => x.key.join("."))).toEqual([
      "recordId",
      "text",
      "tags",
      "occurredAt",
    ]);
    expect(s.scalars.find((x) => x.column === "owner_id")).toBeUndefined();
  });
  it("embeds non-repeatable components as nested keys over prefixed columns", () => {
    const s = wireShape(doc, ct("Transaction"), ["owner_id"]);
    const minor = s.scalars.find((x) => x.column === "amount_minor")!;
    expect(minor.key).toEqual(["amount", "minor"]);
    expect(minor.type).toBe("bigInteger");
  });
  it("realizes repeatable components as children", () => {
    const s = wireShape(doc, ct("ActivitySession"), ["owner_id"]);
    expect(s.children).toHaveLength(1);
    expect(s.children[0]).toMatchObject({
      key: ["quantities"],
      relation: "quantities",
      model: "ActivitySessionQuantities",
    });
    expect(s.children[0]!.scalars.map((x) => x.column)).toEqual(["amount", "unit"]);
  });
  it("uses id as the key column without upsertBy", () => {
    expect(wireShape(doc, ct("Tag"), []).keyColumn).toBe("id");
  });
  it("a repeatable nested in a non-repeatable keys by path", () => {
    const s = wireShape(nestedDoc, nestedDoc.contentTypes[0]!, []);
    expect(s.children[0]).toMatchObject({
      key: ["facts", "additional"],
      relation: "factsAdditional",
    });
  });
});
